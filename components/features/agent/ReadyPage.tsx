'use client';

// ReadyPage — /ready (PRODUCT §5.8; F-AGENT-01, 04, 08, 10; F-FILT-07).
//
//   intro          before setup, while the list is empty (ReadyIntro)
//   header         "You submit each application yourself." · Settings
//   allowance      kits left this week (server's `ready_kits` bucket)
//   progress       real counts per state group (F-AGENT-08) over this week's
//                  list (items whose weekKey is the server's `weekKey`); when
//                  the server does not name the week it is labelled as the
//                  whole list instead, never as "this week"
//   search card    which saved search the list comes from; filter edits ask
//                  "Use this for your main search too?" (F-FILT-07)
//   tabs           To prepare · Ready · Done (?tab=prepare|ready|done), grouped
//                  like the contract's TAB_STATES (being prepared → Ready;
//                  expired → Done, flagged with Remove)
//   To prepare     select → "Prepare kits" (cost shown first, F-AGENT-10);
//                  suggestions to add
//
// Flag `agent`: off → no page (R-04). D1: no button here applies or submits.

import { Suspense, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn, EmptyState, FitTierLabel, HonestyLine, PageHeader, Tabs, tabPanelProps, toast } from '../../v3/primitives';
import { useCapabilities, useFlag } from '../../../lib/flags';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import {
  READY_TABS,
  canPrepare,
  countKits,
  isUnavailable,
  progressScope,
  tabOf,
  useAddToList,
  useAgentSetup,
  useReadyQueue,
  useSuggestions,
  type PrepareRunResult,
  type ReadyTab,
} from '../../../hooks/agent';
import { jobDetailHref } from '../job';
import { KitAllowance } from './KitAllowance';
import { KitRow } from './KitRow';
import { PrepareSheet } from './PrepareSheet';
import { ReadyIntro } from './ReadyIntro';
import { ReadySearchCard } from './ReadySearchCard';
import { SETUP_HREF, setupStepHref } from './states';
import styles from './ready.module.css';

const TABS_ID = 'ready-tabs';

export function ReadyPage() {
  return (
    <Suspense fallback={null}>
      <Ready />
    </Suspense>
  );
}

/** "Ready to apply" is not offered here (flag off, or the API is not live). */
export function ReadyUnavailable() {
  const t = useTranslations('ready');
  return <EmptyState title={t('unavailable.title')} sub={t('unavailable.sub')} action={<Link href="/jobs" className="btn">{t('unavailable.back')}</Link>} />;
}

function Ready() {
  const t = useTranslations('ready');
  const { status } = useCapabilities();
  const on = useFlag('agent');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const setup = useAgentSetup({ enabled: on });
  const queue = useReadyQueue({ enabled: on });

  const fromUrl = params?.get('tab') ?? null;
  const tab: ReadyTab = (READY_TABS as readonly string[]).includes(fromUrl ?? '') ? (fromUrl as ReadyTab) : 'prepare';
  const setTab = useCallback(
    (next: ReadyTab) => {
      const p = new URLSearchParams(params?.toString() ?? '');
      if (next === 'prepare') p.delete('tab');
      else p.set('tab', next);
      const qs = p.toString();
      const path = pathname ?? '/ready';
      router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    },
    [params, pathname, router],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preparing, setPreparing] = useState<string[] | null>(null);

  const items = useMemo(() => queue.data?.items ?? [], [queue.data]);
  const counts = useMemo(() => countKits(items), [items]);
  const progress = useMemo(() => {
    const p = progressScope(items, queue.data?.weekKey);
    return { scope: p.scope, counts: countKits(p.items) };
  }, [items, queue.data?.weekKey]);
  const inTab = useMemo(() => items.filter((i) => tabOf(i) === tab), [items, tab]);
  const preparable = useMemo(() => items.filter((i) => canPrepare(i.state)).map((i) => i.id), [items]);
  const chosen = preparable.filter((id) => selected.has(id));

  if (!on) return status === 'loading' ? null : <ReadyUnavailable />;
  if (isUnavailable(queue.error) || isUnavailable(setup.error)) return <ReadyUnavailable />;
  if (queue.isLoading || setup.isLoading) {
    return (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  }
  if (queue.isError) {
    return (
      <EmptyState
        title={t('error.title')}
        sub={t('error.sub')}
        action={
          <Btn onClick={() => void queue.refetch()}>
            {t('error.retry')}
          </Btn>
        }
      />
    );
  }

  const setupDone = setup.data?.step === 'done';
  if (!setupDone && items.length === 0) return <ReadyIntro started={!!setup.data && setup.data.step !== 'profile'} />;

  const onSelect = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allChosen = preparable.length > 0 && chosen.length === preparable.length;

  const onPrepared = (r: PrepareRunResult) => {
    setSelected(new Set());
    if (r.prepared.length > 0) toast({ message: t('prepare.started', { count: r.prepared.length }), tone: 'ok' });
    if (r.ok && r.failed.length > 0) toast({ message: t('prepare.runFailed', { count: r.failed.length }), tone: 'warn' });
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('title')}
        sub={<HonestyLine kind="you_submit" />}
        actions={
          <Link href={setupStepHref('weekly')} className="btn ghost">
            {t('header.settings')}
          </Link>
        }
      />
      <KitAllowance />

      {!setupDone ? (
        <section className={styles.cardWarn} data-testid="setup-unfinished">
          <p className={styles.body}>{t('header.setupUnfinished')}</p>
          <div className={styles.row}>
            <Link href={SETUP_HREF} className="btn">
              {t('intro.continue')}
            </Link>
          </div>
        </section>
      ) : null}

      <p className={styles.muted} id="ready-progress-label">
        {progress.scope === 'week' ? t('progress.label') : t('progress.labelAll')}
      </p>
      <ul className={styles.progress} aria-labelledby="ready-progress-label" data-testid="ready-progress" data-scope={progress.scope}>
        <li className={styles.progressItem}>
          <span className={styles.progressValue}>{progress.counts.toPrepare}</span>
          <span className={styles.muted}>{t('progress.toPrepare')}</span>
        </li>
        <li className={styles.progressItem}>
          <span className={styles.progressValue}>{progress.counts.preparing}</span>
          <span className={styles.muted}>{t('progress.preparing')}</span>
        </li>
        <li className={styles.progressItem}>
          <span className={styles.progressValue}>{progress.counts.readyNotOpened}</span>
          <span className={styles.muted}>{t('progress.ready')}</span>
        </li>
        <li className={styles.progressItem}>
          <span className={styles.progressValue}>{progress.counts.applied}</span>
          <span className={styles.muted}>{t('progress.applied')}</span>
        </li>
      </ul>

      <ReadySearchCard />

      <Tabs
        idBase={TABS_ID}
        ariaLabel={t('tabs.label')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'prepare', label: t('tabs.prepare'), count: counts.prepare },
          { id: 'ready', label: t('tabs.ready'), count: counts.ready },
          { id: 'done', label: t('tabs.done'), count: counts.done },
        ]}
      />
      <div {...tabPanelProps(TABS_ID, tab)} className={styles.stack}>
        {tab === 'done' && counts.expired > 0 ? (
          <p className={styles.blocker} role="note">
            {t('list.expiredNote', { count: counts.expired })}
          </p>
        ) : null}
        {tab === 'prepare' && preparable.length > 0 ? (
          <label className={styles.toggle}>
            <input type="checkbox" checked={allChosen} onChange={(e) => setSelected(e.target.checked ? new Set(preparable) : new Set())} />
            <span>{t('list.selectAll', { count: preparable.length })}</span>
          </label>
        ) : null}
        {inTab.length === 0 ? (
          <EmptyState title={t(`list.empty.${tab}.title`)} sub={t(`list.empty.${tab}.sub`)} />
        ) : (
          <ul className={styles.plainList} aria-label={t(`tabs.${tab}`)}>
            {inTab.map((item) => (
              <KitRow
                key={item.id}
                item={item}
                selectable={tab === 'prepare'}
                selected={selected.has(item.id)}
                onSelect={onSelect}
                onPrepare={(id) => setPreparing([id])}
              />
            ))}
          </ul>
        )}
        {tab === 'prepare' ? <Suggestions /> : null}
        {tab === 'prepare' && chosen.length > 0 ? (
          <div className={styles.selectBar} data-testid="prepare-bar">
            <span className={styles.body}>{t('list.selected', { count: chosen.length })}</span>
            <Btn variant="primary" onClick={() => setPreparing(chosen)}>
              {t('list.prepareSelected', { count: chosen.length })}
            </Btn>
          </div>
        ) : null}
      </div>

      <PrepareSheet open={preparing !== null} ids={preparing ?? []} onClose={() => setPreparing(null)} onDone={onPrepared} />
    </div>
  );
}

/** Top fits that are not on the list yet (GET /agent/suggestions); "Add" puts one on the list. */
function Suggestions() {
  const t = useTranslations('ready');
  const q = useSuggestions({ limit: 5 });
  const add = useAddToList();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const items = (q.data?.items ?? []).filter((j) => !added.has(j.jobId)).slice(0, 5);
  if (q.isLoading || q.isError || items.length === 0) return null;

  const onAdd = async (jobId: string) => {
    try {
      await add.mutateAsync({ jobIds: [jobId], addedVia: 'suggestions' });
      setAdded((s) => new Set(s).add(jobId));
    } catch (err) {
      const code = apiErrorCode(err);
      toast({ message: code === 'conflict' || code === 'queue_full' ? t('suggestions.full') : t('suggestions.failed'), tone: 'warn' });
    }
  };

  return (
    <section className={styles.card} aria-labelledby="ready-suggestions-title" data-testid="ready-suggestions">
      <h2 id="ready-suggestions-title" className={styles.sectionTitle}>
        {t('suggestions.title')}
      </h2>
      <p className={styles.muted}>{t('suggestions.sub')}</p>
      <ul className={styles.plainList}>
        {items.map((job) => (
          <li key={job.jobId} className={`${styles.kit} ${styles.kitNoSelect}`}>
            <div className={styles.kitMain}>
              <p className={styles.kitTitle}>
                <Link href={jobDetailHref(job.jobId)}>{job.title}</Link>
              </p>
              <p className={styles.kitMeta}>
                <span>{job.company.name}</span>
                {job.fit ? <FitTierLabel tier={job.fit.tier} score={job.fit.score} estimate={job.fit.kind !== 'ai'} /> : null}
              </p>
            </div>
            <div className={styles.kitActions}>
              <Btn onClick={() => void onAdd(job.jobId)} disabled={add.isPending} aria-label={t('suggestions.addAria', { title: job.title })}>
                {t('suggestions.add')}
              </Btn>
            </div>
          </li>
        ))}
      </ul>
      <HonestyLine kind="fit" />
    </section>
  );
}
