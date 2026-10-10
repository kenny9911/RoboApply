'use client';

// ReadySearchCard — which search the weekly list comes from, and filter
// changes made inside Ready to apply (PRODUCT F-FILT-07: when filters change
// here, ask "Use this for your main search too?").
//
// The weekly list always comes from the main search (the one Jobs shows).
// Edits happen on a draft; on /ready, saving a change asks the question
// before anything is written:
//   Yes → the main search takes the new filters (the shared filter path, so
//         Jobs and next week's list change too), then matching jobs are
//         added to the list now.
//   No  → the main search is untouched; matching jobs are added to this list
//         now with the changed filters (POST /agent/list/generate
//         `overrides`, WP-52). Next week's list uses the main search again.
// Neither answer creates a saved search, so a plan's saved-search limit never
// gets in the way.
//
// In setup ("Check your search") there is no list yet: saving changes the
// main search, and the card says so before the user saves.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Drawer, Pill } from '../../v3/primitives';
import { FilterSectionsView, activeChips, useEditorContext, useFilterLabels, useProfileLabel } from '../filters';
import {
  hiddenFieldsFor,
  mergePatch,
  normalizeFilters,
  pickActiveProfile,
  sameFilters,
  searchErrorReason,
  useApplyFilters,
  useSearchProfiles,
  type FilterSet,
  type FilterSetPatch,
} from '../../../hooks/search';
import { useGenerateList } from '../../../hooks/agent';
import type { GenerateListResponse } from '../../../lib/api/agent';
import styles from './ready.module.css';

export interface ReadySearchCardProps {
  /** `list` (on /ready) asks the question; `setup` saves to the main search. */
  mode?: 'list' | 'setup';
}

type Stage = 'closed' | 'edit' | 'ask';
type Message = { tone: 'ok' | 'danger'; text: string };

export function ReadySearchCard({ mode = 'list' }: ReadySearchCardProps) {
  const t = useTranslations('ready');
  const ctx = useEditorContext();
  const labels = useFilterLabels();
  const profilesQ = useSearchProfiles();
  const labelFor = useProfileLabel(profilesQ.data?.profiles);
  const { apply, isPending } = useApplyFilters();
  const generate = useGenerateList();

  const main = pickActiveProfile(profilesQ.data);
  const [stage, setStage] = useState<Stage>('closed');
  const [draft, setDraft] = useState<FilterSet>({});
  const [message, setMessage] = useState<Message | null>(null);
  const busy = isPending || generate.isPending;

  const hidden = hiddenFieldsFor(ctx.market);
  const chips = useMemo(
    () =>
      main
        ? activeChips(main.filters, hidden, labels, {
            excluded: (v) => t('search.excluded', { value: v }),
            only: (v) => t('search.only', { value: v }),
            quoted: (v) => `“${v}”`,
          })
        : [],
    [main, hidden, labels, t],
  );

  if (!main) return null;

  const openEdit = () => {
    setDraft(main.filters);
    setMessage(null);
    setStage('edit');
  };
  const set = (patch: FilterSetPatch) => setDraft((d) => mergePatch(d, patch));
  const next = normalizeFilters(draft);

  const fail = (err: unknown) => {
    const reason = searchErrorReason(err);
    setMessage({ tone: 'danger', text: t(reason === 'version_conflict' ? 'search.conflict' : 'search.failed') });
  };

  /** What the list generation did, in plain words. */
  const listMessage = (r: GenerateListResponse, savedMain: boolean): Message => {
    if (r.added > 0) return { tone: 'ok', text: t(savedMain ? 'search.addedBoth' : 'search.addedReady', { count: r.added }) };
    const why = r.reason ?? 'no_matches';
    return { tone: 'ok', text: `${savedMain ? t('search.savedBoth') : ''}${savedMain ? ' ' : ''}${t(`search.none.${why}`)}`.trim() };
  };

  /** The main search takes the new filters. */
  const saveMain = async (): Promise<boolean> => {
    const r = await apply({ profile: main, replace: next, defaultCountry: ctx.defaultCountry });
    if (!r.ok) {
      fail(r.error);
      return false;
    }
    return true;
  };

  const onSave = async () => {
    if (sameFilters(main.filters, next)) {
      setStage('closed');
      return;
    }
    if (mode === 'list') {
      setStage('ask');
      return;
    }
    setMessage(null);
    if (await saveMain()) {
      setMessage({ tone: 'ok', text: t('search.savedMain') });
      setStage('closed');
    }
  };

  /** Yes: the main search too; then add matching jobs to the list now. */
  const useForBoth = async () => {
    setMessage(null);
    if (!(await saveMain())) return;
    setStage('closed');
    try {
      setMessage(listMessage(await generate.mutateAsync({ more: true }), true));
    } catch {
      setMessage({ tone: 'ok', text: `${t('search.savedBoth')} ${t('search.listFailed')}` });
    }
  };

  /** No: only this list — add matching jobs with the changed filters; the main search is untouched. */
  const useForListOnly = async () => {
    setMessage(null);
    try {
      const r = await generate.mutateAsync({ overrides: next as Record<string, unknown>, more: true });
      setMessage(listMessage(r, false));
      setStage('closed');
    } catch {
      setMessage({ tone: 'danger', text: t('search.listFailed') });
    }
  };

  return (
    <section className={styles.card} aria-labelledby="ready-search-title" data-testid="ready-search">
      <div className={styles.spread}>
        <h2 id="ready-search-title" className={styles.sectionTitle}>
          {t('search.title')}
        </h2>
        <Btn variant="ghost" onClick={openEdit}>
          {t('search.edit')}
        </Btn>
      </div>
      <p className={styles.body}>
        {t('search.from', { name: labelFor(main) })} <Pill tone="muted">{t('search.mainSearch')}</Pill>
      </p>
      {chips.length > 0 ? (
        <ul className={styles.choices} aria-label={t('search.filtersLabel')}>
          {chips.map((c) => (
            <li key={c.key}>
              <Pill tone="muted">{c.label}</Pill>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>{t('search.noFilters')}</p>
      )}
      {message && stage === 'closed' ? (
        <p role={message.tone === 'danger' ? 'alert' : 'status'} className={message.tone === 'danger' ? styles.error : styles.status}>
          {message.text}
        </p>
      ) : null}

      <Drawer
        open={stage !== 'closed'}
        onClose={() => setStage('closed')}
        title={t('search.drawerTitle')}
        description={mode === 'setup' ? t('search.setupNote') : t('search.drawerDescription', { name: labelFor(main) })}
        footer={
          stage === 'ask' ? (
            <div className={styles.stack} data-testid="ready-search-ask">
              <p className={styles.strong}>{t('search.askTitle')}</p>
              <p className={styles.muted}>{t('search.askNote')}</p>
              {message?.tone === 'danger' ? (
                <p role="alert" className={styles.error}>
                  {message.text}
                </p>
              ) : null}
              <div className={styles.row}>
                <Btn variant="primary" onClick={() => void useForBoth()} disabled={busy}>
                  {t('search.yes')}
                </Btn>
                <Btn onClick={() => void useForListOnly()} disabled={busy}>
                  {t('search.no')}
                </Btn>
                <Btn variant="ghost" onClick={() => setStage('edit')} disabled={busy}>
                  {t('search.back')}
                </Btn>
              </div>
            </div>
          ) : (
            <div className={styles.stack}>
              {message?.tone === 'danger' ? (
                <p role="alert" className={styles.error}>
                  {message.text}
                </p>
              ) : null}
              <div className={styles.row}>
                <Btn variant="ghost" onClick={() => setStage('closed')}>
                  {t('search.cancel')}
                </Btn>
                <Btn variant="primary" onClick={() => void onSave()} disabled={busy}>
                  {t('search.save')}
                </Btn>
              </div>
            </div>
          )
        }
      >
        <FilterSectionsView draft={draft} set={set} ctx={ctx} />
      </Drawer>
    </section>
  );
}
