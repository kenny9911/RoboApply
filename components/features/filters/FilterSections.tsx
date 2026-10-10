'use client';

// components/features/filters/FilterSections.tsx — the drawer's sections
// (Basic · Pay and sponsorship · Interests · Companies, plus Campus and
// internships on GoApply) and the editor context per brand (WP-20).

import type { ComponentType } from 'react';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand';
import type { FilterSet, FilterSetPatch, Market } from '../../../hooks/search/filterModel';
import {
  AgencyEditor,
  ClassYearEditor,
  CompaniesEditor,
  CompanySizeEditor,
  DailyPayEditor,
  DegreeEditor,
  EmployerTagsEditor,
  EmploymentTypeEditor,
  ExcludeRequirementsEditor,
  ExcludedCompaniesEditor,
  ExcludedIndustriesEditor,
  ExcludedSkillsEditor,
  ExcludedTitlesEditor,
  HukouEditor,
  IndustriesEditor,
  InternDaysEditor,
  JobTypeEditor,
  ListedPayEditor,
  LocationEditor,
  PayEditor,
  PostedEditor,
  PreferredCompaniesEditor,
  RecruiterEditor,
  RoleTypeEditor,
  SalaryMonthsEditor,
  SchoolTierEditor,
  SeniorityEditor,
  SkillsEditor,
  SponsorshipEditor,
  TaxonomyEditor,
  TitlesEditor,
  WorkModelEditor,
  YearsEditor,
  type EditorContext,
  type EditorProps,
} from './FilterEditors';
import styles from './filters.module.css';

export type DrawerSection = 'basic' | 'pay' | 'interests' | 'companies' | 'cn';

/** The recruiter bank each market's "Recruiter-posted" filter refers to (real source names, D3). */
const RECRUITER_SOURCE: Record<Market, string> = { intl: 'RoboHire', cn: 'GoHire' };

export function useEditorContext(): EditorContext {
  const brand = useBrand();
  return useMemo(
    () => ({
      market: brand.market,
      countries: brand.countries,
      defaultCountry: brand.defaultCountry,
      currency: brand.currency,
      recruiterSourceName: RECRUITER_SOURCE[brand.market],
    }),
    [brand],
  );
}

type Editor = ComponentType<EditorProps>;

/** Section → editors, per market. Every FilterSet v1 field has a control here, in the quick bar (q) or the fit view (fitTier). */
export function sectionEditors(market: Market): Array<{ id: DrawerSection; editors: Editor[] }> {
  const basic: Editor[] = [TaxonomyEditor, TitlesEditor, ExcludedTitlesEditor, JobTypeEditor, WorkModelEditor, LocationEditor, SeniorityEditor, YearsEditor, PostedEditor];
  const pay: Editor[] = market === 'cn' ? [PayEditor, ListedPayEditor] : [PayEditor, ListedPayEditor, SponsorshipEditor, ExcludeRequirementsEditor];
  const interests: Editor[] = [IndustriesEditor, ExcludedIndustriesEditor, SkillsEditor, ExcludedSkillsEditor, RoleTypeEditor];
  const companies: Editor[] =
    market === 'cn'
      ? // GoApply keeps company size beside its employer tags (D5: the server accepts `companySizes` for both markets).
        [CompaniesEditor, ExcludedCompaniesEditor, PreferredCompaniesEditor, CompanySizeEditor, EmployerTagsEditor, AgencyEditor, RecruiterEditor]
      : [CompaniesEditor, ExcludedCompaniesEditor, PreferredCompaniesEditor, CompanySizeEditor, AgencyEditor, RecruiterEditor];
  const out: Array<{ id: DrawerSection; editors: Editor[] }> = [
    { id: 'basic', editors: basic },
    { id: 'pay', editors: pay },
    { id: 'interests', editors: interests },
    { id: 'companies', editors: companies },
  ];
  if (market === 'cn') {
    out.splice(1, 0, {
      id: 'cn',
      editors: [ClassYearEditor, DegreeEditor, EmploymentTypeEditor, InternDaysEditor, DailyPayEditor, SalaryMonthsEditor, HukouEditor, SchoolTierEditor],
    });
  }
  return out;
}

export function FilterSectionsView({
  draft,
  set,
  ctx,
  only,
}: {
  draft: FilterSet;
  set: (patch: FilterSetPatch) => void;
  ctx: EditorContext;
  /** Render only these sections (e.g. a deep link from a quick button). */
  only?: DrawerSection[];
}) {
  const t = useTranslations('filters');
  const sections = sectionEditors(ctx.market).filter((s) => !only || only.includes(s.id));
  return (
    <div className={styles.drawerBody}>
      {sections.map((s) => (
        <section key={s.id} className={styles.section} aria-labelledby={`filters-section-${s.id}`} data-section={s.id}>
          <h3 id={`filters-section-${s.id}`} className={styles.sectionTitle}>
            {t(`sections.${s.id}`)}
          </h3>
          {s.editors.map((E, i) => (
            <E key={i} draft={draft} set={set} ctx={ctx} />
          ))}
        </section>
      ))}
    </div>
  );
}
