'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { RAWorkType } from '../../../lib/api/v2';
import { IconSearch } from '../primitives';

export interface DiscoveryFilters {
  query: string;
  workType: RAWorkType | 'all';
  salaryOnly: boolean;
}

export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = { query: '', workType: 'all', salaryOnly: false };

export function DiscoveryControls({ value, onChange, visibleCount, totalCount }: {
  value: DiscoveryFilters;
  onChange: (value: DiscoveryFilters) => void;
  visibleCount: number;
  totalCount: number;
}) {
  const t = useTranslations('jobs');
  const id = useId();
  const filtered = value.query.trim() !== '' || value.workType !== 'all' || value.salaryOnly;
  return (
    <div className="discovery-controls">
      <div className="discovery-controls-row">
        <label className="discovery-search" htmlFor={`${id}-query`}>
          <IconSearch size={18} />
          <span className="sr-only">{t('discovery.search')}</span>
          <input id={`${id}-query`} type="search" value={value.query} placeholder={t('discovery.searchPlaceholder')} onChange={(event) => onChange({ ...value, query: event.target.value })} />
        </label>
        <label className="discovery-work-filter" htmlFor={`${id}-mode`}>
          <span className="sr-only">{t('discovery.workMode')}</span>
          <select id={`${id}-mode`} value={value.workType} onChange={(event) => onChange({ ...value, workType: event.target.value as DiscoveryFilters['workType'] })}>
            <option value="all">{t('discovery.allModes')}</option>
            {(['remote', 'hybrid', 'onsite'] as const).map((mode) => <option key={mode} value={mode}>{t(`work.${mode}`)}</option>)}
          </select>
        </label>
        <label className={`discovery-pay-filter ${value.salaryOnly ? 'active' : ''}`}>
          <input type="checkbox" checked={value.salaryOnly} onChange={(event) => onChange({ ...value, salaryOnly: event.target.checked })} />
          <span>{t('discovery.salaryOnly')}</span>
        </label>
      </div>
      <div className="discovery-filter-summary">
        <span aria-live="polite" aria-atomic="true">{t('discovery.results', { visible: visibleCount, total: totalCount })}</span>
        <span className="discovery-local-hint">{t('discovery.localHint')}</span>
        {filtered ? <button type="button" onClick={() => onChange(DEFAULT_DISCOVERY_FILTERS)}>{t('discovery.clear')}</button> : null}
      </div>
    </div>
  );
}
