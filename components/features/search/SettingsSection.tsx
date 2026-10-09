'use client';

// /settings#search — saved searches (TASK_PLAN.md WP-20; PRODUCT F-FEED-03).
//
// Every saved search with: its name (rename), "Main" (the default; cannot be
// deleted — make another one main first) and "In use" (the one the feed
// uses), a filter summary, "Edit filters" (the same drawer as /jobs), "Use
// this search", "Make this your main search", delete (never the last or the
// main one), and its new-job alerts: instant alerts up to the plan's
// `instant_alerts` entitlement ("As they arrive" on Pro; never "unlimited")
// and a daily/weekly email summary. Every write is one PATCH with
// `baseVersion`.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { FiltersDrawer, SavedSearchNote, useProfileLabel } from '../filters';
import {
  activeFilterCount,
  searchErrorReason,
  useActivateSearchProfile,
  useCreateSearchProfile,
  useDeleteSearchProfile,
  useSearchProfiles,
  useUpdateSearchProfile,
  type SearchProfile,
  type SearchProfileList,
} from '../../../hooks/search';
import type { SettingsSectionProps } from '../settings/sectionComponents';
import styles from '../filters/filters.module.css';

const INSTANT_OPTIONS = [0, 1, 2, 5, 100] as const;

function ProfileCard({ profile, list, onEdit }: { profile: SearchProfile; list: SearchProfileList; onEdit: (p: SearchProfile) => void }) {
  const t = useTranslations('filters');
  const update = useUpdateSearchProfile();
  const activate = useActivateSearchProfile();
  const remove = useDeleteSearchProfile();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(profile.name);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = useProfileLabel(list.profiles)(profile);
  const canDelete = !profile.isDefault && list.profiles.length > 1;

  const patch = (body: Omit<Parameters<typeof update.mutate>[0]['body'], 'baseVersion'>, failKey: string) => {
    setError(null);
    update.mutate(
      { id: profile.id, body: { ...body, baseVersion: profile.version } },
      { onError: (err) => setError(searchErrorReason(err) === 'version_conflict' ? t('drawer.conflict') : t(failKey)) },
    );
  };

  const onDelete = () => {
    setError(null);
    remove.mutate(profile.id, {
      onError: (err) => {
        const reason = searchErrorReason(err);
        setError(
          reason === 'cannot_delete_default_profile'
            ? t('saved.cannotDeleteMain')
            : reason === 'cannot_delete_last_profile'
              ? t('saved.cannotDeleteLast')
              : t('saved.deleteFailed'),
        );
      },
    });
  };

  return (
    <li className={styles.profileCard}>
      <div className={styles.profileHead}>
        {renaming ? (
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              patch({ name: name.trim() }, 'drawer.saveFailed');
              setRenaming(false);
            }}
          >
            <input className={styles.input} aria-label={t('saved.namePlaceholder')} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <Btn type="submit" variant="primary">
              {t('saved.save')}
            </Btn>
            <Btn variant="ghost" onClick={() => setRenaming(false)}>
              {t('saved.cancel')}
            </Btn>
          </form>
        ) : (
          <h3 className={styles.profileName}>{label}</h3>
        )}
        <div className={styles.actions}>
          {profile.isDefault ? <span className={styles.pill}>{t('saved.main')}</span> : null}
          {profile.isActive ? <span className={styles.pill}>{t('saved.inUse')}</span> : null}
        </div>
      </div>
      <p className={styles.help}>{t('settings.filtersSummary', { count: activeFilterCount(profile.filters) })}</p>
      <div className={styles.actions}>
        <Btn onClick={() => onEdit(profile)}>{t('settings.editFilters')}</Btn>
        {!profile.isActive ? (
          <Btn variant="ghost" onClick={() => activate.mutate(profile.id)} disabled={activate.isPending}>
            {t('saved.use')}
          </Btn>
        ) : null}
        {!profile.isDefault ? (
          <Btn variant="ghost" onClick={() => patch({ makeDefault: true }, 'drawer.saveFailed')} disabled={update.isPending}>
            {t('saved.makeMain')}
          </Btn>
        ) : null}
        {!renaming ? (
          <Btn
            variant="ghost"
            onClick={() => {
              setName(profile.name);
              setRenaming(true);
            }}
          >
            {t('saved.rename')}
          </Btn>
        ) : null}
        {canDelete && !confirming ? (
          <Btn variant="ghost" onClick={() => setConfirming(true)}>
            {t('saved.delete')}
          </Btn>
        ) : null}
      </div>
      {confirming ? (
        <div className={styles.inlineForm} role="group" aria-label={t('saved.confirmDelete', { name: label })}>
          <p className={styles.status}>{t('saved.confirmDelete', { name: label })}</p>
          <Btn variant="primary" onClick={onDelete} disabled={remove.isPending}>
            {t('saved.confirmDeleteAction')}
          </Btn>
          <Btn variant="ghost" onClick={() => setConfirming(false)}>
            {t('saved.cancel')}
          </Btn>
        </div>
      ) : null}

      <fieldset className={styles.field}>
        <legend className={styles.fieldLabel}>{t('settings.alerts')}</legend>
        <div className={styles.alertsRow}>
          <label>
            {t('settings.instant')}
            <select
              className={styles.select}
              value={profile.alertInstantMax}
              disabled={update.isPending}
              onChange={(e) => patch({ alertInstantMax: Number(e.target.value) as (typeof INSTANT_OPTIONS)[number] }, 'settings.alertsSaveFailed')}
            >
              {INSTANT_OPTIONS.map((n) => (
                <option key={n} value={n} disabled={n > list.maxInstantAlerts}>
                  {t(`settings.instantOptions.${n}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('settings.digest')}
            <select
              className={styles.select}
              value={profile.alertDigest ?? 'none'}
              disabled={update.isPending}
              onChange={(e) => patch({ alertDigest: e.target.value === 'none' ? null : (e.target.value as 'daily' | 'weekly') }, 'settings.alertsSaveFailed')}
            >
              <option value="none">{t('settings.digestOptions.none')}</option>
              <option value="daily">{t('settings.digestOptions.daily')}</option>
              <option value="weekly">{t('settings.digestOptions.weekly')}</option>
            </select>
          </label>
        </div>
        {list.upgradable && list.maxInstantAlerts < 100 ? <p className={styles.help}>{t('settings.alertsProNote')}</p> : null}
      </fieldset>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** The saved-searches manager (also rendered by the legacy HuntSection until INT wires this section). */
export function SavedSearchesManager() {
  const t = useTranslations('filters');
  const query = useSearchProfiles();
  const create = useCreateSearchProfile();
  const [editing, setEditing] = useState<SearchProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (query.isLoading) return <p className={styles.status}>{t('settings.loading')}</p>;
  if (query.isError || !query.data) {
    return (
      <div role="alert" className={styles.field}>
        <p className={styles.error}>{t('settings.loadFailed')}</p>
        <Btn onClick={() => void query.refetch()}>{t('settings.retry')}</Btn>
      </div>
    );
  }

  const list = query.data;
  const atCap = list.profiles.length >= list.maxProfiles;
  const main = list.profiles.find((p) => p.isDefault) ?? list.profiles[0];
  const current = editing ? (list.profiles.find((p) => p.id === editing.id) ?? editing) : null;

  return (
    <div className={styles.drawerBody}>
      <ul className={styles.profiles}>
        {list.profiles.map((p) => (
          <ProfileCard key={p.id} profile={p} list={list} onEdit={setEditing} />
        ))}
      </ul>
      <div className={styles.actions}>
        <Btn
          onClick={() => {
            setError(null);
            create.mutate(
              { name: '', filters: main?.filters ?? {} },
              { onError: (err) => setError(searchErrorReason(err) === 'saved_search_limit' ? t('saved.limitReached') : t('saved.createFailed')) },
            );
          }}
          disabled={atCap || create.isPending}
        >
          {t('saved.saveAs')}
        </Btn>
      </div>
      {atCap ? <SavedSearchNote list={list} /> : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <FiltersDrawer open={!!current} onClose={() => setEditing(null)} profile={current} />
    </div>
  );
}

export function SettingsSection(_props: SettingsSectionProps) {
  const t = useTranslations('filters.settings');
  return (
    <section aria-labelledby="settings-search-title" className={styles.section}>
      <div>
        <p className={styles.help}>{t('eyebrow')}</p>
        <h2 id="settings-search-title" className={styles.sectionTitle}>
          {t('title')}
        </h2>
        <p className={styles.help}>{t('sub')}</p>
      </div>
      <SavedSearchesManager />
    </section>
  );
}

export default SettingsSection;
