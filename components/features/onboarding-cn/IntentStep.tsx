'use client';

// G4 求职期望 (/onboarding/intent) — PRODUCT_PLAN.md §4.5 G4.
//
// Roles 1–3 (typeahead over the zh job taxonomy, free text allowed); cities
// ≤5 picked by province (no 一线/新一线 tiers — they come from a commercial
// ranking we cannot cite) or 不限; industries ≤3 (GB/T 4754 sections); 工作性质
// (在校 defaults to 实习); 全职 pay as K/月 + ·N薪 or 面议; 实习 元/天, days a
// week (default 4) and months (default 3个月); 到岗时间; 接受调剂 (students).
// The live panel shows real counts from our index only.

import { useEffect, useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { CnProvince } from '../../../lib/api/contracts/onboarding-cn';
import { useCnOnboardingApi } from './api';
import { OpportunityPanel } from './OpportunityPanel';
import type { CnOnboardingStepProps } from './types';
import { ChoiceChips, MultiChips, SelectField, StepFrame, SwitchRow, useSaveStep, useStoredAnswers } from './parts';
import {
  CN_ANY_CITY,
  CN_INDUSTRY_CODES,
  CN_INTERN_DAILY_OPTIONS,
  CN_INTERN_DAYS_OPTIONS,
  CN_INTERN_MONTHS,
  CN_MAX_CITIES,
  CN_MAX_INDUSTRIES,
  CN_MAX_ROLES,
  CN_SALARY_K_OPTIONS,
  CN_SALARY_MONTHS_OPTIONS,
  CN_START_DATES,
  CN_WORK_TYPES,
  formatMonthlyK,
  identityOf,
  isStudent,
  stepAnswers,
  toggleMulti,
  type CnWorkType,
} from './logic';
import { loadCnPlaceData } from './places';
import styles from './OnboardingCn.module.css';

type Role = { taxonomyId?: string; label: string };
type Industry = (typeof CN_INDUSTRY_CODES)[number];
type InternMonths = (typeof CN_INTERN_MONTHS)[number];
type StartDate = (typeof CN_START_DATES)[number];

export interface IntentForm {
  roles: Role[];
  cities: string[];
  industries: Industry[];
  workType: CnWorkType;
  negotiable: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryMonths: number | null;
  dailyMin: number | null;
  dailyMax: number | null;
  days: number;
  months: InternMonths;
  startDate: StartDate;
  startDateValue: string;
  acceptReassignment: boolean;
}

/** The request body for PUT /onboarding/steps/intent (the server re-validates it). */
export function intentBody(f: IntentForm, student: boolean): Record<string, unknown> {
  const internship = f.workType === 'internship';
  return {
    targetRoles: f.roles,
    cities: f.cities,
    ...(f.industries.length ? { industries: f.industries } : {}),
    workType: f.workType,
    ...(!internship && f.negotiable ? { salaryMonthlyK: 'negotiable' } : {}),
    ...(!internship && !f.negotiable && f.salaryMin !== null && f.salaryMax !== null
      ? { salaryMonthlyK: { min: f.salaryMin, max: f.salaryMax }, ...(f.salaryMonths ? { salaryMonths: f.salaryMonths } : {}) }
      : {}),
    ...(internship
      ? {
          internDailyPay: f.dailyMin !== null && f.dailyMax !== null ? { min: f.dailyMin, max: f.dailyMax } : 'any',
          internDaysPerWeek: f.days,
          internMonths: f.months,
        }
      : {}),
    startDate: f.startDate,
    ...(f.startDate === 'date' ? { startDateValue: f.startDateValue } : {}),
    ...(student ? { acceptReassignment: f.acceptReassignment } : {}),
  };
}

export function intentProblems(f: IntentForm): string[] {
  const out: string[] = [];
  if (!f.roles.length) out.push('roles');
  if (!f.cities.length) out.push('cities');
  if (f.workType !== 'internship' && !f.negotiable && (f.salaryMin === null) !== (f.salaryMax === null)) out.push('salaryBoth');
  if (f.workType !== 'internship' && f.salaryMin !== null && f.salaryMax !== null && f.salaryMin > f.salaryMax) out.push('salaryOrder');
  if (f.workType === 'internship' && (f.dailyMin === null) !== (f.dailyMax === null)) out.push('salaryBoth');
  if (f.workType === 'internship' && f.dailyMin !== null && f.dailyMax !== null && f.dailyMin > f.dailyMax) out.push('salaryOrder');
  if (f.startDate === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(f.startDateValue)) out.push('date');
  return out;
}

function RolePicker({ roles, onChange }: { roles: Role[]; onChange: (r: Role[]) => void }) {
  const t = useTranslations('onboardingCn');
  const locale = useLocale();
  const api = useCnOnboardingApi();
  const id = useId();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Array<{ taxonomyId: string; label: string; context: string | null }>>([]);
  const full = roles.length >= CN_MAX_ROLES;

  useEffect(() => {
    const text = q.trim();
    if (!text) return setItems([]);
    let live = true;
    const timer = setTimeout(() => {
      api
        .suggestRoles(text, locale)
        .then((list) => live && setItems(list.slice(0, 6)))
        .catch(() => live && setItems([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, q, locale]);

  function add(role: Role) {
    const label = role.label.trim();
    if (!label || full || roles.some((r) => r.label === label)) return;
    onChange([...roles, { ...role, label }]);
    setQ('');
    setItems([]);
  }

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {t('intent.rolesLabel')}
        <span className={styles.required}>{t('intent.rolesHint', { max: CN_MAX_ROLES })}</span>
      </label>
      {roles.length ? (
        <div className={styles.picked}>
          {roles.map((r) => (
            <button key={r.label} type="button" aria-pressed className={styles.chip} onClick={() => onChange(roles.filter((x) => x !== r))} aria-label={t('common.remove', { label: r.label })}>
              {r.label} ×
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.combo}>
        <input
          id={id}
          className={styles.input}
          value={q}
          disabled={full}
          maxLength={80}
          autoComplete="off"
          placeholder={full ? t('intent.rolesFull') : t('intent.rolesPlaceholder')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add({ label: q });
            }
          }}
        />
        {q.trim() && !full ? (
          <ul className={styles.options} role="listbox" aria-label={t('intent.rolesLabel')}>
            {items.map((s) => (
              <li key={s.taxonomyId} role="option" aria-selected={false}>
                <button type="button" className={styles.option} onClick={() => add({ taxonomyId: s.taxonomyId, label: s.label })}>
                  <span>{s.label}</span>
                  {s.context ? <span className={styles.optionMeta}>{s.context}</span> : null}
                </button>
              </li>
            ))}
            <li role="option" aria-selected={false}>
              <button type="button" className={styles.option} onClick={() => add({ label: q })}>
                {t('intent.rolesAddCustom', { label: q.trim() })}
              </button>
            </li>
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function CityPicker({ cities, onChange, provinces }: { cities: string[]; onChange: (c: string[]) => void; provinces: CnProvince[] }) {
  const t = useTranslations('onboardingCn');
  const id = useId();
  const [province, setProvince] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const current = provinces.find((p) => p.code === province) ?? null;
  const toggle = (c: string) => onChange(toggleMulti(cities, c, { max: CN_MAX_CITIES, exclusive: CN_ANY_CITY }));
  return (
    <div className={styles.section} role="group" aria-labelledby={id}>
      <span id={id} className={styles.label}>
        {t('intent.citiesLabel')}
        <span className={styles.required}>{t('intent.citiesHint', { max: CN_MAX_CITIES })}</span>
      </span>
      <div className={styles.picked}>
        <button type="button" aria-pressed={cities.includes(CN_ANY_CITY)} className={styles.chip} onClick={() => toggle(CN_ANY_CITY)}>
          {t('intent.anyCity')}
        </button>
        {cities
          .filter((c) => c !== CN_ANY_CITY)
          .map((c) => (
            <button key={c} type="button" aria-pressed className={styles.chip} onClick={() => toggle(c)} aria-label={t('common.remove', { label: c })}>
              {c} ×
            </button>
          ))}
      </div>
      {provinces.length ? (
        <>
          <span className={styles.fieldLabel}>{t('intent.provinceLabel')}</span>
          <div className={styles.provinces}>
            {provinces.map((p) => (
              <button key={p.code} type="button" aria-pressed={province === p.code} className={styles.chip} onClick={() => setProvince(province === p.code ? null : p.code)}>
                {p.name}
              </button>
            ))}
          </div>
          {current ? (
            <div className={styles.chips} aria-label={current.name}>
              {[...current.cities, ...(current.extra ?? [])].map((c) => (
                <button key={c} type="button" aria-pressed={cities.includes(c)} className={styles.chip} onClick={() => toggle(c)}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      <div className={styles.row}>
        <input
          className={styles.input}
          value={other}
          maxLength={60}
          placeholder={t('intent.otherCity')}
          aria-label={t('intent.otherCity')}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (other.trim()) toggle(other.trim());
              setOther('');
            }
          }}
        />
        <button
          type="button"
          className={styles.chip}
          disabled={!other.trim()}
          onClick={() => {
            toggle(other.trim());
            setOther('');
          }}
        >
          {t('intent.addCity')}
        </button>
      </div>
    </div>
  );
}

export function IntentStep({ onDone, onBack }: CnOnboardingStepProps) {
  const t = useTranslations('onboardingCn');
  const { answers, loaded } = useStoredAnswers();
  const [provinces, setProvinces] = useState<CnProvince[]>([]);
  const identity = identityOf(answers);
  const student = isStudent(identity);
  const [form, setForm] = useState<IntentForm>({
    roles: [],
    cities: [],
    industries: [],
    workType: 'full_time',
    negotiable: false,
    salaryMin: null,
    salaryMax: null,
    salaryMonths: null,
    dailyMin: null,
    dailyMax: null,
    days: 4,
    months: '3',
    startDate: 'anytime',
    startDateValue: '',
    acceptReassignment: false,
  });
  const set = (p: Partial<IntentForm>) => setForm((f) => ({ ...f, ...p }));
  const { save, saving, error } = useSaveStep('intent', onDone);

  useEffect(() => {
    loadCnPlaceData()
      .then((d) => setProvinces(d.provinces))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const prev = stepAnswers(answers, 'intent');
    const id = identityOf(answers);
    if (!prev.workType) {
      set({ workType: id === 'zaixiao' ? 'internship' : 'full_time' });
      return;
    }
    const salary = prev.salaryMonthlyK;
    const daily = prev.internDailyPay;
    set({
      roles: Array.isArray(prev.targetRoles) ? (prev.targetRoles as Role[]) : [],
      cities: Array.isArray(prev.cities) ? (prev.cities as string[]) : [],
      industries: Array.isArray(prev.industries) ? (prev.industries as Industry[]) : [],
      workType: prev.workType as CnWorkType,
      negotiable: salary === 'negotiable',
      salaryMin: salary && typeof salary === 'object' ? (salary as { min: number }).min : null,
      salaryMax: salary && typeof salary === 'object' ? (salary as { max: number }).max : null,
      salaryMonths: typeof prev.salaryMonths === 'number' ? prev.salaryMonths : null,
      dailyMin: daily && typeof daily === 'object' ? (daily as { min: number }).min : null,
      dailyMax: daily && typeof daily === 'object' ? (daily as { max: number }).max : null,
      days: typeof prev.internDaysPerWeek === 'number' ? prev.internDaysPerWeek : 4,
      months: (prev.internMonths as InternMonths) ?? '3',
      startDate: (prev.startDate as StartDate) ?? 'anytime',
      startDateValue: typeof prev.startDateValue === 'string' ? prev.startDateValue : '',
      acceptReassignment: prev.acceptReassignment === true,
    });
  }, [answers, loaded]);

  const problems = intentProblems(form);
  const internship = form.workType === 'internship';
  const classYear = typeof stepAnswers(answers, 'identity').graduationClass === 'number' ? (stepAnswers(answers, 'identity').graduationClass as number) : null;
  const query = useMemo(() => ({ roles: form.roles, cities: form.cities, classYear }), [form.roles, form.cities, classYear]);
  const preview =
    !internship && !form.negotiable && form.salaryMin !== null && form.salaryMax !== null && form.salaryMin <= form.salaryMax
      ? formatMonthlyK({ min: form.salaryMin, max: form.salaryMax }, form.salaryMonths)
      : null;

  return (
    <StepFrame
      step="intent"
      title={t('intent.title')}
      onBack={onBack}
      nextDisabled={problems.length > 0}
      disabledHint={problems.length ? t(`intent.problem.${problems[0]}` as 'intent.problem.roles') : null}
      saving={saving}
      error={error}
      onSubmit={() => void save(intentBody(form, student))}
    >
      <RolePicker roles={form.roles} onChange={(roles) => set({ roles })} />
      <CityPicker cities={form.cities} onChange={(cities) => set({ cities })} provinces={provinces} />
      <OpportunityPanel query={query} />
      <MultiChips
        label={t('intent.industriesLabel')}
        hint={t('intent.industriesHint', { max: CN_MAX_INDUSTRIES })}
        options={CN_INDUSTRY_CODES}
        value={form.industries}
        onToggle={(v) => set({ industries: toggleMulti(form.industries, v, { max: CN_MAX_INDUSTRIES }) })}
        render={(v) => t(`industry.${v}`)}
      />
      <ChoiceChips label={t('intent.workTypeLabel')} options={CN_WORK_TYPES} value={form.workType} onChange={(workType) => set({ workType })} render={(v) => t(`intent.workType.${v}`)} required />

      {!internship ? (
        <div className={styles.section}>
          <span className={styles.label}>{t('intent.salaryLabel')}</span>
          <div className={styles.row}>
            <SelectField label={t('intent.salaryMin')} value={form.negotiable ? null : form.salaryMin} options={CN_SALARY_K_OPTIONS} onChange={(v) => set({ salaryMin: v, negotiable: false })} render={(k) => `${k}K`} />
            <SelectField label={t('intent.salaryMax')} value={form.negotiable ? null : form.salaryMax} options={CN_SALARY_K_OPTIONS} onChange={(v) => set({ salaryMax: v, negotiable: false })} render={(k) => `${k}K`} />
          </div>
          <SelectField
            label={t('intent.salaryMonthsLabel')}
            value={form.salaryMonths}
            options={CN_SALARY_MONTHS_OPTIONS}
            onChange={(v) => set({ salaryMonths: v })}
            render={(n) => t('intent.salaryMonthsOption', { n })}
          />
          <div className={styles.chips}>
            <button type="button" aria-pressed={form.negotiable} className={styles.chip} onClick={() => set({ negotiable: !form.negotiable, salaryMin: null, salaryMax: null, salaryMonths: null })}>
              {t('intent.negotiable')}
            </button>
          </div>
          {preview ? <p className={styles.note}>{t('intent.salaryPreview', { value: preview })}</p> : null}
        </div>
      ) : (
        <>
          <div className={styles.section}>
            <span className={styles.label}>{t('intent.dailyLabel')}</span>
            <div className={styles.row}>
              <SelectField label={t('intent.salaryMin')} value={form.dailyMin} options={CN_INTERN_DAILY_OPTIONS} onChange={(v) => set({ dailyMin: v })} render={(n) => t('intent.dailyOption', { n })} placeholder={t('intent.dailyAny')} />
              <SelectField label={t('intent.salaryMax')} value={form.dailyMax} options={CN_INTERN_DAILY_OPTIONS} onChange={(v) => set({ dailyMax: v })} render={(n) => t('intent.dailyOption', { n })} placeholder={t('intent.dailyAny')} />
            </div>
          </div>
          <ChoiceChips label={t('intent.daysLabel')} options={CN_INTERN_DAYS_OPTIONS} value={form.days} onChange={(days) => set({ days })} render={(n) => t('intent.daysOption', { n })} required />
          <ChoiceChips label={t('intent.monthsLabel')} options={CN_INTERN_MONTHS} value={form.months} onChange={(months) => set({ months })} render={(v) => t(`intent.months.${v === '1-2' ? 'm12' : v === '3' ? 'm3' : 'm6'}`)} required />
        </>
      )}

      <ChoiceChips label={t('intent.startLabel')} options={CN_START_DATES} value={form.startDate} onChange={(startDate) => set({ startDate })} render={(v) => t(`intent.start.${v}`)} />
      {form.startDate === 'date' ? (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="cn-start-date">
            {t('intent.startDateLabel')}
          </label>
          <input id="cn-start-date" type="date" className={styles.input} value={form.startDateValue} onChange={(e) => set({ startDateValue: e.target.value })} />
        </div>
      ) : null}
      {student ? <SwitchRow label={t('intent.reassign')} hint={t('intent.reassignHint')} checked={form.acceptReassignment} onChange={(v) => set({ acceptReassignment: v })} /> : null}
    </StepFrame>
  );
}
