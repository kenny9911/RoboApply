'use client';

// Work authorization per target country (ruling C18: a question the user
// answers, never a label we infer; TW-09 adds the Taiwan work-permit answer)
// and the Taiwan job preferences (TW-04: 希望職稱 / 地點 / 待遇 incl. 面議 and
// 依公司規定). RoboApply only.

import { useMemo, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { ProfileView } from '../../../lib/api/contracts/profile';
import { useProfileMutations } from '../../../hooks/profile/useProfile';
import { TW_ANYWHERE, TW_COUNTIES, TW_WORK_PERMIT_STATUSES, countryName, sortedCountries } from './options';
import { Checkbox, Choices, SaveRow, SectionCard, SelectField, TextField, useDraft, type SaveState } from './parts';
import s from './profile.module.css';

type WorkAuth = ProfileView['workAuth'][number];
type TwFields = NonNullable<ProfileView['twFields']>;

const boolToChoice = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');
const choiceToBool = (v: string) => (v === 'yes' ? true : v === 'no' ? false : null);

export function WorkAuthSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const locale = useLocale();
  const { patch } = useProfileMutations();
  const { draft, update, markClean } = useDraft(profile.workAuth, () => profile.workAuth);
  const [adding, setAdding] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const countries = useMemo(() => sortedCountries(locale), [locale]);
  const missing = profile.missing.some((m) => m.key === 'workAuth');

  const change = (country: string, next: Partial<WorkAuth>) => {
    update((d) => d.map((w) => (w.country === country ? { ...w, ...next } : w)));
    setState('idle');
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setState('saving');
    try {
      await patch.mutateAsync({ workAuth: draft });
      markClean();
      setState('saved');
    } catch {
      setState('error');
    }
  }

  return (
    <SectionCard id="workAuth" title={t('sections.workAuth')} intro={t('workAuth.intro')} missing={missing}>
      <form onSubmit={save} noValidate>
        {draft.length === 0 ? <p className={s.empty}>{t('workAuth.empty')}</p> : null}
        <ul className={s.rows}>
          {draft.map((w) => {
            const name = countryName(w.country, locale);
            return (
              <li key={w.country} className={s.row}>
                <div className={s.rowHead}>
                  <p className={s.rowTitle}>{name}</p>
                  <div className={s.rowActions}>
                    <Btn
                      variant="ghost"
                      aria-label={t('workAuth.removeCountry', { country: name })}
                      onClick={() => {
                        update((d) => d.filter((x) => x.country !== w.country));
                        setState('idle');
                      }}
                    >
                      {t('actions.delete')}
                    </Btn>
                  </div>
                </div>
                <Choices
                  legend={t('workAuth.authorized', { country: name })}
                  name={`auth-${w.country}`}
                  value={boolToChoice(w.authorized) as '' | 'yes' | 'no'}
                  onChange={(v) => change(w.country, { authorized: choiceToBool(v) })}
                  options={[
                    { value: 'yes', label: t('workAuth.yes') },
                    { value: 'no', label: t('workAuth.no') },
                    { value: '', label: t('workAuth.notAnswered') },
                  ]}
                />
                <Choices
                  legend={t('workAuth.sponsorship', { country: name })}
                  name={`sponsor-${w.country}`}
                  value={w.sponsorship ?? ''}
                  onChange={(v) => change(w.country, { sponsorship: v === '' ? null : v })}
                  options={[
                    { value: 'now', label: t('workAuth.sponsorshipNow') },
                    { value: 'later', label: t('workAuth.sponsorshipLater') },
                    { value: 'no', label: t('workAuth.sponsorshipNo') },
                    { value: '', label: t('workAuth.notAnswered') },
                  ]}
                />
                {w.country === 'TW' ? (
                  <SelectField
                    label={t('workAuth.permit')}
                    value={w.permit ?? ''}
                    placeholder={t('workAuth.notAnswered')}
                    onChange={(v) => change('TW', { permit: v ? (v as WorkAuth['permit']) : null })}
                    options={TW_WORK_PERMIT_STATUSES.map((p) => ({ value: p, label: t(`workAuth.permits.${p}`) }))}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {draft.length < 20 ? (
          <div className={s.field}>
            <label className={s.label} htmlFor="profile-workauth-add">
              {t('workAuth.addCountry')}
            </label>
            <div className={s.inline}>
              <select id="profile-workauth-add" className={s.select} value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">{t('personal.countryPlaceholder')}</option>
                {countries
                  .filter((c) => !draft.some((w) => w.country === c.code))
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <Btn
                disabled={!adding}
                onClick={() => {
                  update((d) => [...d, { country: adding, authorized: null, sponsorship: null }]);
                  setAdding('');
                  setState('idle');
                }}
              >
                {t('actions.add')}
              </Btn>
            </div>
          </div>
        ) : null}
        <SaveRow state={state} />
      </form>
    </SectionCard>
  );
}

// ── Taiwan job preferences ─────────────────────────────────────────────

type PayKind = 'none' | 'monthly' | 'annual' | 'negotiable' | 'company_policy';

interface TwDraft {
  titles: string[];
  places: string[];
  payKind: PayKind;
  payMin: string;
  payMax: string;
}

function twDraftOf(f: TwFields | null): TwDraft {
  const pay = f?.desiredPay ?? null;
  return {
    titles: f?.desiredTitles ?? [],
    places: f?.desiredLocations ?? [],
    payKind: pay ? pay.kind : 'none',
    payMin: pay && 'range' in pay && pay.range.min !== null ? String(pay.range.min) : '',
    payMax: pay && 'range' in pay && pay.range.max !== null ? String(pay.range.max) : '',
  };
}

const amount = (v: string): number | null => {
  const n = Number(v.replace(/[,\s]/g, ''));
  return v.trim() && Number.isInteger(n) && n >= 0 ? n : null;
};

export function TaiwanSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const { patch } = useProfileMutations();
  const { draft, update, markClean } = useDraft(profile.twFields, () => twDraftOf(profile.twFields));
  const [title, setTitle] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const [payError, setPayError] = useState<string | null>(null);
  const available = profile.availability.twFields;

  const set = (fn: (d: TwDraft) => TwDraft) => {
    update(fn);
    setState('idle');
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    let desiredPay: TwFields['desiredPay'] = null;
    if (draft.payKind === 'monthly' || draft.payKind === 'annual') {
      const min = amount(draft.payMin);
      const max = amount(draft.payMax);
      if ((min === null && max === null) || (min !== null && max !== null && min > max)) {
        setPayError(t('taiwan.payInvalid'));
        setState('error');
        return;
      }
      desiredPay = { kind: draft.payKind, range: { min, max } };
    } else if (draft.payKind === 'negotiable' || draft.payKind === 'company_policy') {
      desiredPay = { kind: draft.payKind };
    }
    setPayError(null);
    setState('saving');
    try {
      await patch.mutateAsync({
        twFields: {
          desiredTitles: draft.titles,
          desiredLocations: draft.places as TwFields['desiredLocations'],
          desiredPay,
          // No input for job categories yet (typeahead pending): keep what is stored, since the server replaces twFields whole.
          ...(profile.twFields?.desiredCategoryIds?.length ? { desiredCategoryIds: profile.twFields.desiredCategoryIds } : {}),
        },
      });
      markClean();
      setState('saved');
    } catch {
      setState('error');
    }
  }

  if (!available) {
    return (
      <SectionCard id="taiwan" title={t('sections.taiwan')} optional>
        <p className={s.note}>{t('taiwan.unavailable')}</p>
      </SectionCard>
    );
  }

  const togglePlace = (code: string, on: boolean) =>
    set((d) => ({ ...d, places: on ? [...d.places.filter((p) => p !== code), code] : d.places.filter((p) => p !== code) }));

  return (
    <SectionCard id="taiwan" title={t('sections.taiwan')} intro={t('taiwan.intro')} optional>
      <form onSubmit={save} noValidate>
        <div className={s.field}>
          <label className={s.label} htmlFor="profile-tw-title">
            {t('taiwan.titles')}
          </label>
          <ul className={s.chips}>
            {draft.titles.map((x) => (
              <li key={x} className={s.chip}>
                {x}
                <button type="button" className={s.chipRemove} aria-label={t('actions.remove', { name: x })} onClick={() => set((d) => ({ ...d, titles: d.titles.filter((y) => y !== x) }))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {draft.titles.length < 5 ? (
            <div className={s.inline}>
              <input
                id="profile-tw-title"
                className={s.input}
                value={title}
                maxLength={80}
                aria-describedby="profile-tw-title-hint"
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = title.trim();
                    if (v && !draft.titles.includes(v)) set((d) => ({ ...d, titles: [...d.titles, v] }));
                    setTitle('');
                  }
                }}
              />
              <Btn
                disabled={!title.trim()}
                onClick={() => {
                  const v = title.trim();
                  if (v && !draft.titles.includes(v)) set((d) => ({ ...d, titles: [...d.titles, v] }));
                  setTitle('');
                }}
              >
                {t('actions.add')}
              </Btn>
            </div>
          ) : null}
          <span id="profile-tw-title-hint" className={s.hint}>
            {t('taiwan.titlesHint')}
          </span>
        </div>

        <fieldset className={`${s.fieldset} ${s.spaced}`}>
          <legend className={s.legend}>{t('taiwan.places')}</legend>
          <div className={s.placeGrid}>
            <Checkbox label={t('taiwan.anywhere')} checked={draft.places.includes(TW_ANYWHERE)} onChange={(on) => togglePlace(TW_ANYWHERE, on)} />
            {TW_COUNTIES.map((c) => (
              <Checkbox key={c} label={t(`taiwan.counties.${c}`)} checked={draft.places.includes(c)} onChange={(on) => togglePlace(c, on)} />
            ))}
          </div>
        </fieldset>

        <div className={`${s.grid} ${s.spaced}`}>
          <SelectField
            label={t('taiwan.pay')}
            value={draft.payKind}
            onChange={(v) => set((d) => ({ ...d, payKind: v as PayKind }))}
            options={(['none', 'monthly', 'annual', 'negotiable', 'company_policy'] as const).map((k) => ({ value: k, label: t(`taiwan.payKinds.${k}`) }))}
          />
          <span />
          {draft.payKind === 'monthly' || draft.payKind === 'annual' ? (
            <>
              <TextField label={t('taiwan.payMin')} inputMode="numeric" value={draft.payMin} onChange={(v) => set((d) => ({ ...d, payMin: v }))} error={payError} maxLength={12} />
              <TextField label={t('taiwan.payMax')} inputMode="numeric" value={draft.payMax} onChange={(v) => set((d) => ({ ...d, payMax: v }))} maxLength={12} />
            </>
          ) : null}
        </div>
        <SaveRow state={state} />
      </form>
    </SectionCard>
  );
}
