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
//
// Taiwan (MKT-5F; JT-7, JT-8), RoboApply only and only for a search in Taiwan:
//   - under a location that is a Taiwanese county, a district picker (the
//     county's 鄉鎮市區 from GET /tw/districts; names are the postal list's
//     data, not copy). A choice is stored as `<county><district>`. The filter
//     is one rule for the whole search (only the chosen districts), so when
//     the search has another place whose jobs it leaves out, one line under
//     the pickers says so;
//   - a shift control (the five values a posting's own field can state);
//   - under the pay toggle, one line that says where stated pay comes from.
// Each says that it keeps only postings that state the district or the shift,
// so a shorter list is explained, not silent. None of them shows on GoApply
// or for a search outside Taiwan.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';

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
  isCountryWideLocation,
  sponsorshipCountry,
  type FilterField,
  type FilterLocation,
  type FilterSet,
  type FilterSetPatch,
  type Market,
} from '../../../hooks/search/filterModel';
import { useCompanySuggestions, useSkillSuggestions, useTaxonomyLabels, useTitleSuggestions } from '../../../hooks/search/useFilterQueries';
import { TW_DISTRICTS_STALE_MS, getTwDistricts, httpsHref, isTaiwanSearch, twCountiesOfPlace, twKeys, type TwCountyView } from '../../../lib/api/tw';
import { IconX } from '../../v3/primitives/Iconset';
import { NegotiablePayNote } from '../market';
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

// ── Taiwan: counties, districts and shifts ────────────────────────────────

type WorkShiftValue = NonNullable<FilterSet['workShifts']>[number];
/** The shift values a filter can hold, in the order they are offered (typed against the contract: a renamed value fails the build). */
export const WORK_SHIFTS: readonly WorkShiftValue[] = Object.keys({ day: true, evening: true, night: true, rotating: true, part_time: true } satisfies Record<WorkShiftValue, true>) as WorkShiftValue[];
/** Districts one search can name (the contract's TW_DISTRICTS_MAX). */
export const TW_DISTRICTS_MAX = 20;

const isTw = (c: string | null | undefined) => typeof c === 'string' && c.trim().toUpperCase() === 'TW';

/**
 * Whether the browser needs the county table at all: RoboApply only, and only
 * for a search that could be in Taiwan (its country is TW or unset, a place
 * with no country or with TW, or Taiwan filters already chosen). A search
 * whose country and places all say another country never asks.
 */
export function mayBeTaiwanSearch(market: Market, draft: Pick<FilterSet, 'country' | 'locations' | 'twDistricts' | 'workShifts'>): boolean {
  if (market !== 'intl') return false;
  if (isTw(draft.country) || draft.twDistricts?.length || draft.workShifts?.length) return true;
  return (draft.locations ?? []).some((l) => !l.country || isTw(l.country));
}

function useTwDistrictsQuery(market: Market, draft: Pick<FilterSet, 'country' | 'locations' | 'twDistricts' | 'workShifts'>) {
  return useQuery({
    queryKey: twKeys.districts,
    queryFn: ({ signal }) => getTwDistricts({ signal }),
    enabled: mayBeTaiwanSearch(market, draft),
    staleTime: TW_DISTRICTS_STALE_MS,
    retry: false,
  });
}

/**
 * The 22 counties with their districts (GET /tw/districts), or an empty list
 * while they load, when the request fails, and whenever the search cannot be
 * in Taiwan (then nothing is requested). One request a day however many
 * editors ask.
 */
export function useTwCounties(market: Market, draft: Pick<FilterSet, 'country' | 'locations' | 'twDistricts' | 'workShifts'>): readonly TwCountyView[] {
  return useTwDistrictsQuery(market, draft).data?.counties ?? NO_COUNTIES;
}
const NO_COUNTIES: readonly TwCountyView[] = [];

/** The credit line the district list owes its source (open data, attribution required), or null when the table carries none. */
export interface TwDistrictsCredit {
  text: string;
  /** The licence text (https), or null. */
  url: string | null;
}

function useTwDistrictsCredit(market: Market, draft: Pick<FilterSet, 'country' | 'locations' | 'twDistricts' | 'workShifts'>): TwDistrictsCredit | null {
  const source = useTwDistrictsQuery(market, draft).data?.source;
  const text = typeof source?.attribution === 'string' ? source.attribution.trim() : '';
  return text ? { text, url: httpsHref(source?.licenseUrl) } : null;
}

/** The Taiwanese counties the draft's places name, each once, in the order of the places. */
export function draftCounties(draft: Pick<FilterSet, 'locations'>, counties: readonly TwCountyView[]): TwCountyView[] {
  const out: TwCountyView[] = [];
  for (const l of draft.locations ?? []) {
    for (const c of twCountiesOfPlace(l, counties)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Whether a district choice leaves out the jobs of another place of the search
 * (JT-7). The pickers are drawn one per county, which reads as a choice inside
 * that county, but the filter is one rule for the whole search: only postings
 * whose district is one of the chosen ones. So with districts chosen, every
 * job of a county that has no district chosen, and every job of a place
 * outside Taiwan (or of "anywhere in Taiwan"), is left out. True in those
 * cases, so the drawer can say it; false with no district chosen, and while
 * the county table has not arrived (then no picker is on screen either). Pure.
 */
export function districtsLeaveOutOtherPlaces(draft: Pick<FilterSet, 'locations' | 'twDistricts'>, counties: readonly TwCountyView[]): boolean {
  const chosen = new Set(draft.twDistricts ?? []);
  if (!chosen.size || !counties.length) return false;
  const places = draft.locations ?? [];
  // A place that names no Taiwanese county: another country, or the whole of Taiwan.
  if (places.some((l) => twCountiesOfPlace(l, counties).length === 0)) return true;
  // A county of the search with none of its districts chosen.
  return draftCounties({ locations: places }, counties).some((c) => !c.districts.some((d) => chosen.has(d.value)));
}

/** The districts of one county, as toggles. A choice is stored as `<county><district>`; the label is the district's own name. */
function DistrictPicker({ county, draft, set }: { county: TwCountyView; draft: FilterSet; set: (patch: FilterSetPatch) => void }) {
  const t = useTranslations('filters');
  const chosen = draft.twDistricts ?? [];
  const own = new Set(county.districts.map((d) => d.value));
  const selected = chosen.filter((v) => own.has(v));
  const others = chosen.filter((v) => !own.has(v));
  const full = chosen.length >= TW_DISTRICTS_MAX;
  return (
    <div data-tw-county={county.code}>
      <OptionToggles
        label={t('fields.twDistrictsOf', { county: county.name })}
        help={full ? t('help.twDistrictsFull', { max: TW_DISTRICTS_MAX }) : t('help.twDistricts')}
        options={county.districts.map((d) => ({ value: d.value, label: d.name }))}
        selected={selected}
        onChange={(next) => {
          // At the limit a district can still be taken off; nothing more is added.
          const kept = [...others, ...(next ?? [])];
          if (kept.length > TW_DISTRICTS_MAX && kept.length > chosen.length) return;
          set({ twDistricts: kept.length ? kept : null });
        }}
      />
    </div>
  );
}

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
  // Taiwan: a district picker under each place that is a Taiwanese county (RoboApply only).
  const twTable = useTwCounties(ctx.market, draft);
  const credit = useTwDistrictsCredit(ctx.market, draft);
  const counties = ctx.market === 'intl' ? draftCounties(draft, twTable) : [];
  const remove = (i: number) => {
    const next = locations.filter((_, j) => j !== i);
    const patch: FilterSetPatch = { locations: next.length ? next : null };
    // The districts chosen under a county go with it, unless another place still names that county.
    if (draft.twDistricts?.length && twTable.length) {
      const still = new Set(draftCounties({ locations: next }, twTable).flatMap((c) => c.districts.map((d) => d.value)));
      const gone = new Set(twCountiesOfPlace(locations[i]!, twTable).flatMap((c) => c.districts.map((d) => d.value)));
      const kept = draft.twDistricts.filter((v) => !gone.has(v) || still.has(v));
      if (kept.length !== draft.twDistricts.length) patch.twDistricts = kept.length ? kept : null;
    }
    set(patch);
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
          {locations.map((l, i) => {
            // A country with no city is the whole country: its name, and no distance to pick.
            const whole = isCountryWideLocation(l);
            const name = whole ? labels.value('locations', l, draft) : l.label;
            return (
              <li key={`${l.label}-${i}`} className={styles.tag}>
                <span className={styles.tagText}>{name}</span>
                {whole ? null : (
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
                )}
                <button type="button" className={styles.chipRemove} aria-label={t('controls.remove', { label: name })} onClick={() => remove(i)}>
                  <IconX size={14} />
                </button>
              </li>
            );
          })}
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
      {counties.map((county) => (
        <DistrictPicker key={county.code} county={county} draft={draft} set={set} />
      ))}
      {counties.length && districtsLeaveOutOtherPlaces(draft, twTable) ? (
        // One rule for the whole search: said here, so the jobs of the other places do not vanish without a word.
        <p className={styles.help} data-tw-districts-only="">
          {t('help.twDistrictsOnly')}
        </p>
      ) : null}
      {counties.length && credit ? (
        // The district names are open data (中華郵政, 政府資料開放授權條款 第1版): its credit line, where the list is shown.
        <p className={styles.help} lang="zh-Hant" data-tw-districts-credit="">
          {credit.url ? (
            <a className={styles.noteLink} href={credit.url} target="_blank" rel="noopener noreferrer">
              {credit.text}
            </a>
          ) : (
            credit.text
          )}
        </p>
      ) : null}
    </FieldShell>
  );
}

/**
 * Shift pattern (JT-7): RoboApply only, for a search in Taiwan. The help says
 * that it keeps only postings that state a shift, so a shorter list is no
 * surprise. Renders nothing anywhere else.
 */
export function WorkShiftEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  const twTable = useTwCounties(ctx.market, draft);
  if (ctx.market !== 'intl' || !isTaiwanSearch(draft, twTable)) return null;
  return (
    <OptionToggles
      label={t('fields.workShifts')}
      help={t('help.workShifts')}
      options={WORK_SHIFTS.map((v) => ({ value: v, label: t(`options.workShifts.${v}`) }))}
      selected={draft.workShifts}
      onChange={(v) => set(asPatch('workShifts', v))}
    />
  );
}

// ── Pay and sponsorship ───────────────────────────────────────────────────

function toAmount(raw: string): number | undefined {
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * RoboApply: amount + period in the brand/existing currency. GoApply: K a month (CNY).
 * A NEW pay floor on a search in Taiwan starts as New Taiwan dollars a month,
 * the way postings there state pay (MARKET_STRATEGY §1.5 "Pay": monthly TWD as
 * posted): a floor in the brand's currency could never be compared with a
 * posting that states TWD. A floor that is already set keeps its own currency
 * and period, and nothing changes for a search outside Taiwan.
 */
export function PayEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  const twTable = useTwCounties(ctx.market, draft);
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
  const taiwan = isTaiwanSearch(draft, twTable);
  const currency = s?.currency ?? (taiwan ? 'TWD' : ctx.currency);
  const period = s?.period ?? (taiwan ? 'month' : 'year');
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

/**
 * Whether the Taiwan 面議 note belongs beside the pay toggle: RoboApply only,
 * for a reader in Traditional Chinese (Taiwan) or a search set to Taiwan
 * (its country, or one of its places: a place that says TW, or, with the
 * county table loaded, a place that names a Taiwanese county). Pure.
 */
export function showsTaiwanPayNote(market: Market, locale: string, draft: Pick<FilterSet, 'country' | 'locations'>, counties: readonly TwCountyView[] = []): boolean {
  if (market !== 'intl') return false;
  if (locale === 'zh-TW') return true;
  return isTaiwanSearch(draft, counties);
}

/**
 * "Only jobs that list pay": off by default (includeUndisclosedPay defaults to
 * true). For Taiwan readers and searches, "Why is pay not listed?" sits under
 * it (Employment Services Act Art. 5; the note never estimates a job's pay).
 */
export function ListedPayEditor({ draft, set, ctx }: EditorProps) {
  const t = useTranslations('filters');
  const locale = useLocale();
  const twTable = useTwCounties(ctx.market, draft);
  return (
    <>
      <CheckRow
        label={t('controls.listedPayToggle')}
        help={t('help.includeUndisclosedPay')}
        checked={draft.includeUndisclosedPay === false}
        onChange={(on) => set({ includeUndisclosedPay: on ? false : null })}
      />
      {showsTaiwanPayHelper(ctx.market, draft, twTable) ? (
        <p className={styles.help} data-tw-pay-helper="">
          {t('help.twPay')}
        </p>
      ) : null}
      {showsTaiwanPayNote(ctx.market, locale, draft, twTable) ? <NegotiablePayNote context="filter" /> : null}
    </>
  );
}

/**
 * Whether the pay helper line shows (JT-8): RoboApply, a search in Taiwan,
 * and a pay filter that is on (a pay floor, or "Only jobs that list pay").
 * It says where stated pay comes from and what the toggle then leaves out.
 * The sentence is true in both states: a floor alone keeps postings that
 * state no pay (feed/sql.ts `salaryMin`), and only the toggle removes them,
 * so the line names the toggle and never says "filter by pay". Never for a
 * search outside Taiwan (a reader in Traditional Chinese who searches the
 * United States does not get it). Pure.
 */
export function showsTaiwanPayHelper(market: Market, draft: Pick<FilterSet, 'country' | 'locations' | 'salaryMin' | 'includeUndisclosedPay'>, counties: readonly TwCountyView[] = []): boolean {
  if (market !== 'intl') return false;
  const payFilterOn = !!draft.salaryMin || draft.includeUndisclosedPay === false;
  return payFilterOn && isTaiwanSearch(draft, counties);
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

/** Company size (when known), on both brands; GoApply shows it beside employer type. No funding-stage filter. */
export function CompanySizeEditor({ draft, set }: EditorProps) {
  const t = useTranslations('filters');
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
