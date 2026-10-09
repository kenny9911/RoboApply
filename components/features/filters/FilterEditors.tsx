'use client';

// components/features/filters/FilterEditors.tsx — one editor per FilterSet v1
// field (WP-20). The drawer groups them into sections; the quick-filter
// sheets reuse single editors. Every editor edits a DRAFT through `set(patch)`
// (a value replaces the field, `null`/undefined clears it); nothing is saved
// until the caller applies the draft in one PATCH.
//
// Market rules: GoApply (cn) hides sponsorship and "require citizenship /
// clearance", shows 届别 / 学历 / 工作性质 / 实习天数 / K·N薪 / 元/天 /
// employer tags / 户口 / school tier, and uses employer type instead of
// company size (PRODUCT F-FILT-01…04). Radius is shown in km or miles by
// country (stored in km).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  CN_DEGREES,
  CN_EMPLOYMENT_TYPES,
  COMPANY_SIZES,
  EMPLOYER_TAGS,
  EXCLUDE_REQUIREMENTS,
  JOB_TYPES,
  PAY_PERIODS,
  POSTED_WITHIN_DAYS,
  RADIUS_KM,
  SALARY_MONTHS,
  SCHOOL_TIERS,
  SENIORITY_LEVELS,
  WORK_MODELS,
  classYearOptions,
  sponsorshipCountry,
  type FilterField,
  type FilterLocation,
  type FilterSet,
  type FilterSetPatch,
  type Market,
} from '../../../hooks/search/filterModel';
import { useCompanySuggestions, useSkillSuggestions, useTaxonomyLabels, useTitleSuggestions } from '../../../hooks/search/useFilterQueries';
import { IconX } from '../../v3/primitives/Iconset';
import { CheckRow, FieldShell, NumberRange, OptionToggles, SegmentedChoice, TagField, type Suggestion } from './FilterControls';
import { useFilterLabels } from './useFilterLabels';
import styles from './filters.module.css';

export interface EditorContext {
  market: Market;
  /** Countries the brand serves (country picker). */
  countries: readonly string[];
  /** Brand default country (sponsorship question, radius unit). */
  defaultCountry: string;
  /** Brand currency for a new pay floor. */
  currency: string;
  /** Recruiter bank shown in "Recruiter-posted" help (a real source name: RoboHire / GoHire). */
  recruiterSourceName: string;
}

export interface EditorProps {
  draft: FilterSet;
  set: (patch: FilterSetPatch) => void;
  ctx: EditorContext;
}

const orUndef = <T,>(v: T[] | undefined): T[] | undefined => (v && v.length ? v : undefined);
const asPatch = (field: FilterField, value: unknown): FilterSetPatch => ({ [field]: value === undefined ? null : value }) as FilterSetPatch;

// ── Basic ─────────────────────────────────────────────────────────────────

export function TaxonomyEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  const labels = useTaxonomyLabels();
  const [q, setQ] = useState('');
  const { data } = useTitleSuggestions(q);
  const suggestions: Suggestion[] = (data ?? []).map((s) => ({ value: s.id, label: s.label, context: s.context }));
  return (
    <TagField
      label={t('fields.taxonomyIds')}
      help={t('help.taxonomyIds')}
      values={draft.taxonomyIds}
      onChange={(v) => set(asPatch('taxonomyIds', orUndef(v)))}
      query={q}
      onQueryChange={setQ}
      suggestions={suggestions}
      allowCustom={false}
      placeholder={t('controls.functionPlaceholder')}
      renderValue={(id) => labels.get(id) ?? id}
    />
  );
}

function TitleList({ draft, set, field }: EditorProps & { field: 'titles' | 'excludedTitles' }) {
  const t = useTranslations('filters');
  const [q, setQ] = useState('');
  const { data } = useTitleSuggestions(q);
  const suggestions: Suggestion[] = (data ?? []).filter((s) => s.level === 3).map((s) => ({ value: s.label, label: s.label, context: s.context }));
  return (
    <TagField
      label={t(`fields.${field}`)}
      help={field === 'titles' ? t('help.titles') : undefined}
      values={draft[field]}
      onChange={(v) => set(asPatch(field, orUndef(v)))}
      query={q}
      onQueryChange={setQ}
      suggestions={suggestions}
      placeholder={t('controls.titlePlaceholder')}
    />
  );
}

export const TitlesEditor = (p: EditorProps) => <TitleList {...p} field="titles" />;
export const ExcludedTitlesEditor = (p: EditorProps) => <TitleList {...p} field="excludedTitles" />;

export function JobTypeEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <OptionToggles
      label={t('fields.jobTypes')}
      options={JOB_TYPES.map((v) => ({ value: v, label: t(`options.jobTypes.${v}`) }))}
      selected={draft.jobTypes}
      onChange={(v) => set(asPatch('jobTypes', v))}
    />
  );
}

export function WorkModelEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <OptionToggles
      label={t('fields.workModels')}
      options={WORK_MODELS.map((v) => ({ value: v, label: t(`options.workModels.${v}`) }))}
      selected={draft.workModels}
      onChange={(v) => set(asPatch('workModels', v))}
    />
  );
}

export function SeniorityEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <OptionToggles
      label={t('fields.seniority')}
      options={SENIORITY_LEVELS.map((v) => ({ value: v, label: t(`options.seniority.${v}`) }))}
      selected={draft.seniority}
      onChange={(v) => set(asPatch('seniority', v))}
    />
  );
}

export function YearsEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <NumberRange
      label={t('fields.yearsRange')}
      help={t('help.yearsRange')}
      value={draft.yearsRange}
      min={0}
      max={50}
      unit={t('controls.yearsUnit')}
      onChange={(v) => set(asPatch('yearsRange', v))}
    />
  );
}

export function PostedEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  const value = draft.postedWithinDays ? String(draft.postedWithinDays) : 'any';
  return (
    <SegmentedChoice
      label={t('fields.postedWithinDays')}
      options={[{ value: 'any', label: t('options.postedWithinDays.any') }, ...POSTED_WITHIN_DAYS.map((d) => ({ value: String(d), label: t(`options.postedWithinDays.${d}`) }))]}
      value={value}
      onChange={(v) => set({ postedWithinDays: v === 'any' ? null : (Number(v) as NonNullable<FilterSet['postedWithinDays']>) })}
    />
  );
}

/** Country + locations with a radius each (km or mi by country; remote jobs pass). */
export function LocationEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  const labels = useFilterLabels();
  const [text, setText] = useState('');
  const locations = draft.locations ?? [];
  const unitCountry = draft.country ?? ctx.defaultCountry;
  const add = () => {
    const label = text.trim();
    if (!label || locations.some((l) => l.label.toLowerCase() === label.toLowerCase())) return;
    const loc: FilterLocation = { label, city: label, radiusKm: 40, ...(draft.country ? { country: draft.country } : {}) };
    set({ locations: [...locations, loc] });
    setText('');
  };
  const update = (i: number, radiusKm: FilterLocation['radiusKm']) => set({ locations: locations.map((l, j) => (j === i ? { ...l, radiusKm } : l)) });
  const remove = (i: number) => {
    const next = locations.filter((_, j) => j !== i);
    set({ locations: next.length ? next : null });
  };
  return (
    <FieldShell label={t('fields.locations')} help={t('help.locations')}>
      {ctx.countries.length > 1 ? (
        <label className={styles.row}>
          <span className={styles.unit}>{t('fields.country')}</span>
          <select className={styles.select} value={draft.country ?? ''} onChange={(e) => set({ country: e.target.value || null })}>
            <option value="">{t('controls.anyCountry')}</option>
            {ctx.countries.map((c) => (
              <option key={c} value={c}>
                {labels.country(c)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {locations.length ? (
        <ul className={styles.tags} aria-label={t('fields.locations')}>
          {locations.map((l, i) => (
            <li key={`${l.label}-${i}`} className={styles.tag}>
              <span className={styles.tagText}>{l.label}</span>
              <select
                className={styles.select}
                aria-label={t('controls.radius')}
                value={l.radiusKm}
                onChange={(e) => update(i, Number(e.target.value) as FilterLocation['radiusKm'])}
              >
                {RADIUS_KM.map((km) => (
                  <option key={km} value={km}>
                    {labels.radius(km, l.country ?? unitCountry)}
                  </option>
                ))}
              </select>
              <button type="button" className={styles.chipRemove} aria-label={t('controls.remove', { label: l.label })} onClick={() => remove(i)}>
                <IconX size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.row}>
        <input
          className={styles.input}
          value={text}
          aria-label={t('controls.locationPlaceholder')}
          placeholder={t('controls.locationPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className={styles.toggle} onClick={add} disabled={!text.trim()}>
          {t('controls.add')}
        </button>
      </div>
    </FieldShell>
  );
}

// ── Pay and sponsorship ───────────────────────────────────────────────────

function toAmount(raw: string): number | undefined {
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** RoboApply: amount + period in the brand/existing currency. GoApply: K a month (CNY). */
export function PayEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  const s = draft.salaryMin;
  if (ctx.market === 'cn') {
    const k = s && s.period === 'month' ? Math.round(s.amount / 1000) : undefined;
    return (
      <FieldShell label={t('fields.salaryMin')}>
        <label className={styles.row}>
          <span className={styles.unit}>{t('controls.kMonth')}</span>
          <input
            className={`${styles.input} ${styles.numberInput}`}
            type="number"
            inputMode="numeric"
            min={1}
            aria-label={t('controls.kMonth')}
            value={k ?? ''}
            onChange={(e) => {
              const v = toAmount(e.target.value);
              set({ salaryMin: v ? { amount: v * 1000, currency: 'CNY', period: 'month' } : null });
            }}
          />
          <span className={styles.unit} aria-hidden="true">
            K
          </span>
        </label>
      </FieldShell>
    );
  }
  const currency = s?.currency ?? ctx.currency;
  const period = s?.period ?? 'year';
  return (
    <FieldShell label={t('fields.salaryMin')}>
      <div className={styles.row}>
        <label className={styles.row}>
          <span className={styles.hidden}>{t('controls.amount')}</span>
          <input
            className={styles.input}
            type="number"
            inputMode="numeric"
            min={1}
            value={s?.amount ?? ''}
            placeholder={t('controls.amount')}
            onChange={(e) => {
              const v = toAmount(e.target.value);
              set({ salaryMin: v ? { amount: v, currency, period } : null });
            }}
          />
        </label>
        <span className={styles.unit}>{currency}</span>
        <label className={styles.row}>
          <span className={styles.hidden}>{t('controls.period')}</span>
          <select
            className={styles.select}
            value={period}
            onChange={(e) => s && set({ salaryMin: { ...s, period: e.target.value as (typeof PAY_PERIODS)[number] } })}
            disabled={!s}
          >
            {PAY_PERIODS.map((p) => (
              <option key={p} value={p}>
                {t(`options.payPeriod.${p}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </FieldShell>
  );
}

/** "Only jobs that list pay": off by default (includeUndisclosedPay defaults to true). */
export function ListedPayEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <CheckRow
      label={t('controls.listedPayToggle')}
      help={t('help.includeUndisclosedPay')}
      checked={draft.includeUndisclosedPay === false}
      onChange={(on) => set({ includeUndisclosedPay: on ? false : null })}
    />
  );
}

/** "I need visa sponsorship in {country}" (TW-09). RoboApply only. */
export function SponsorshipEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  const labels = useFilterLabels();
  if (ctx.market === 'cn') return null;
  const country = sponsorshipCountry(draft, ctx.defaultCountry);
  return (
    <FieldShell label={t('fields.needsSponsorship')} as="div">
      <CheckRow
        label={t('controls.sponsorshipToggle', { country: labels.country(country) })}
        help={t('help.needsSponsorship')}
        checked={draft.needsSponsorship === true}
        onChange={(on) => set({ needsSponsorship: on ? true : null })}
      />
    </FieldShell>
  );
}

export function ExcludeRequirementsEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  if (ctx.market === 'cn') return null;
  return (
    <OptionToggles
      label={t('fields.excludeRequirements')}
      options={EXCLUDE_REQUIREMENTS.map((v) => ({ value: v, label: t(`options.excludeRequirements.${v}`) }))}
      selected={draft.excludeRequirements}
      onChange={(v) => set(asPatch('excludeRequirements', v))}
    />
  );
}

// ── Interests ─────────────────────────────────────────────────────────────

function FreeList({ draft, set, field, placeholder, help }: EditorProps & { field: 'industries' | 'excludedIndustries'; placeholder: string; help?: string }) {
  const t = useTranslations('filters');
  const [q, setQ] = useState('');
  return (
    <TagField
      label={t(`fields.${field}`)}
      help={help}
      values={draft[field]}
      onChange={(v) => set(asPatch(field, orUndef(v)))}
      query={q}
      onQueryChange={setQ}
      suggestions={[]}
      placeholder={placeholder}
    />
  );
}

export function IndustriesEditor(p: EditorProps) {
  const t = useTranslations('filters');
  return <FreeList {...p} field="industries" placeholder={t('controls.industryPlaceholder')} />;
}
export function ExcludedIndustriesEditor(p: EditorProps) {
  const t = useTranslations('filters');
  return <FreeList {...p} field="excludedIndustries" placeholder={t('controls.industryPlaceholder')} />;
}

function SkillList({ draft, set, field }: EditorProps & { field: 'skills' | 'excludedSkills' }) {
  const t = useTranslations('filters');
  const [q, setQ] = useState('');
  const { data } = useSkillSuggestions(q);
  return (
    <TagField
      label={t(`fields.${field}`)}
      help={field === 'skills' ? t('help.skills') : undefined}
      values={draft[field]}
      onChange={(v) => set(asPatch(field, orUndef(v)))}
      query={q}
      onQueryChange={setQ}
      suggestions={(data ?? []).map((s) => ({ value: s.value, label: s.label }))}
      placeholder={t('controls.skillPlaceholder')}
    />
  );
}
export const SkillsEditor = (p: EditorProps) => <SkillList {...p} field="skills" />;
export const ExcludedSkillsEditor = (p: EditorProps) => <SkillList {...p} field="excludedSkills" />;

export function RoleTypeEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <SegmentedChoice
      label={t('fields.roleType')}
      options={[
        { value: 'any', label: t('options.roleType.any') },
        { value: 'ic', label: t('options.roleType.ic') },
        { value: 'manager', label: t('options.roleType.manager') },
      ]}
      value={draft.roleType ?? 'any'}
      onChange={(v) => set({ roleType: v === 'any' ? null : v })}
    />
  );
}

// ── Companies ─────────────────────────────────────────────────────────────

function CompanyList({ draft, set, field }: EditorProps & { field: 'companies' | 'excludedCompanies' | 'preferredCompanies' }) {
  const t = useTranslations('filters');
  const [q, setQ] = useState('');
  const { data } = useCompanySuggestions(q);
  return (
    <TagField
      label={t(`fields.${field}`)}
      help={field === 'preferredCompanies' ? t('help.preferredCompanies') : field === 'companies' ? t('help.companies') : undefined}
      values={draft[field]}
      onChange={(v) => set(asPatch(field, orUndef(v)))}
      query={q}
      onQueryChange={setQ}
      suggestions={(data ?? []).map((c) => ({ value: c.name, label: c.name, context: c.domain }))}
      placeholder={t('controls.companyPlaceholder')}
    />
  );
}
export const CompaniesEditor = (p: EditorProps) => <CompanyList {...p} field="companies" />;
export const ExcludedCompaniesEditor = (p: EditorProps) => <CompanyList {...p} field="excludedCompanies" />;
/** Boost only, never a filter (the legacy "target companies"). */
export const PreferredCompaniesEditor = (p: EditorProps) => <CompanyList {...p} field="preferredCompanies" />;

/** Company size (when known). RoboApply only: GoApply uses employer type. No funding-stage filter. */
export function CompanySizeEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  if (ctx.market === 'cn') return null;
  return (
    <OptionToggles
      label={t('fields.companySizes')}
      help={t('help.companySizes')}
      options={COMPANY_SIZES.map((v) => ({ value: v, label: t(`options.companySizes.${v}`) }))}
      selected={draft.companySizes}
      onChange={(v) => set(asPatch('companySizes', v))}
    />
  );
}

export function AgencyEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <CheckRow
      label={t('controls.agencyToggle')}
      help={t('help.excludeAgencies')}
      checked={draft.excludeAgencies === true}
      onChange={(on) => set({ excludeAgencies: on ? true : null })}
    />
  );
}

/** Recruiter-posted jobs only: free on every plan, no Pro note (F-FEED-04). */
export function RecruiterEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <CheckRow
      label={t('controls.recruiterToggle')}
      help={t('help.recruiterJobsOnly', { sourceName: ctx.recruiterSourceName })}
      checked={draft.recruiterJobsOnly === true}
      onChange={(on) => set({ recruiterJobsOnly: on ? true : null })}
    />
  );
}

export function EmployerTagsEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  if (ctx.market !== 'cn') return null;
  return (
    <OptionToggles
      label={t('fields.employerTags')}
      help={t('help.employerTags')}
      options={EMPLOYER_TAGS.map((v) => ({ value: v, label: t(`options.employerTags.${v}`) }))}
      selected={draft.employerTags}
      onChange={(v) => set(asPatch('employerTags', v))}
    />
  );
}

// ── GoApply: campus and internships ───────────────────────────────────────

export function ClassYearEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <FieldShell label={t('fields.classYear')} as="div">
      <select
        className={styles.select}
        aria-label={t('fields.classYear')}
        value={draft.classYear ?? ''}
        onChange={(e) => set({ classYear: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">{t('options.any')}</option>
        {classYearOptions().map((y) => (
          <option key={y} value={y}>
            {t('options.classYear', { year: y })}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function DegreeEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <OptionToggles
      label={t('fields.degree')}
      options={CN_DEGREES.map((v) => ({ value: v, label: t(`options.degree.${v}`) }))}
      selected={draft.degree}
      onChange={(v) => set(asPatch('degree', v))}
    />
  );
}

export function EmploymentTypeEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <OptionToggles
      label={t('fields.employmentType')}
      options={CN_EMPLOYMENT_TYPES.map((v) => ({ value: v, label: t(`options.employmentType.${v}`) }))}
      selected={draft.employmentType}
      onChange={(v) => set(asPatch('employmentType', v))}
    />
  );
}

export function InternDaysEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <NumberRange
      label={t('fields.internDays')}
      value={draft.internDays}
      min={1}
      max={7}
      unit={t('controls.daysUnit')}
      onChange={(v) => set(asPatch('internDays', v))}
    />
  );
}

export function DailyPayEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <FieldShell label={t('fields.dailyPay')} as="div">
      <label className={styles.row}>
        <span className={styles.unit}>{t('controls.dailyPayAmount')}</span>
        <input
          className={`${styles.input} ${styles.numberInput}`}
          type="number"
          inputMode="numeric"
          min={1}
          aria-label={t('controls.dailyPayAmount')}
          value={draft.dailyPay?.min ?? ''}
          onChange={(e) => {
            const v = toAmount(e.target.value);
            set({ dailyPay: v ? { min: v } : null });
          }}
        />
      </label>
    </FieldShell>
  );
}

export function SalaryMonthsEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <FieldShell label={t('fields.salaryMonthsMin')} help={t('help.salaryMonthsMin')} as="div">
      <select
        className={styles.select}
        aria-label={t('fields.salaryMonthsMin')}
        value={draft.salaryMonthsMin ?? ''}
        onChange={(e) => set({ salaryMonthsMin: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">{t('options.any')}</option>
        {SALARY_MONTHS.map((m) => (
          <option key={m} value={m}>
            {t('options.salaryMonths', { months: m })}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function HukouEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <CheckRow
      label={t('controls.hukouToggle')}
      help={t('help.hukouTag')}
      checked={draft.hukouTag === true}
      onChange={(on) => set({ hukouTag: on ? true : null })}
    />
  );
}

/** The user's own school tier: hides posts that require a tier the user lacks; never a ranking input (C15). */
export function SchoolTierEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
  return (
    <OptionToggles
      label={t('fields.schoolTiers')}
      help={t('help.schoolTiers')}
      options={SCHOOL_TIERS.map((v) => ({ value: v, label: t(`options.schoolTiers.${v}`) }))}
      selected={draft.schoolTiers}
      onChange={(v) => set(asPatch('schoolTiers', v))}
    />
  );
}
