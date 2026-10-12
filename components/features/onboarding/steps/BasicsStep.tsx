'use client';

// O2 — What you're looking for (PRODUCT §4.3). Titles (1–3, taxonomy or
// custom), job types, countries (MVP set + Remote anywhere), cities per
// country (≤5 in total; "Anywhere in {country}" when none), remote jobs, and
// a per-country work-permit question. The live market snapshot sits beside
// the form once a title and a country are chosen. Back · Skip · Next; Skip
// keeps whatever was entered.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { IconX } from '../../../v3/primitives/Iconset';
import { JOB_TYPES, LIMITS, MVP_COUNTRIES, SPONSORSHIP_ANSWERS } from '../options';
import { StepFrame } from '../StepFrame';
import { answersOf, type StepScreenProps } from '../types';
import { MarketSnapshotPanel } from './MarketSnapshotPanel';
import { TitlePicker, type PickedTitle } from './TitlePicker';
import styles from '../onboarding.module.css';

type JobType = (typeof JOB_TYPES)[number];
type Sponsorship = (typeof SPONSORSHIP_ANSWERS)[number];
interface CityRow {
  country: string;
  city: string;
  label: string;
}
interface Basics {
  jobFunctions: PickedTitle[];
  jobTypes: JobType[];
  countries: string[];
  locations: CityRow[];
  remoteOk: boolean;
  needsSponsorship: Record<string, Sponsorship>;
}

function initialTitles(state: StepScreenProps['state'], prev: Partial<Basics>): PickedTitle[] {
  if (prev.jobFunctions?.length) return prev.jobFunctions;
  // "Suggested from resume if one exists from an earlier session" (PRODUCT O2).
  const roles = ((state.answers as Record<string, unknown>).resumeSuggestions as { profileDraft?: { targetRoles?: unknown } } | undefined)?.profileDraft?.targetRoles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string').slice(0, LIMITS.titles).map((label) => ({ label })) : [];
}

export function BasicsStep({ state, save, onBack, onLeave, busy, error, position }: StepScreenProps) {
  const t = useTranslations('onboarding.basics');
  const tc = useTranslations('onboarding.countries');
  const prev = answersOf<Basics>(state, 'basics');
  const seekerType = answersOf<{ seekerType: string }>(state, 'situation').seekerType;
  const [titles, setTitles] = useState<PickedTitle[]>(() => initialTitles(state, prev));
  const [jobTypes, setJobTypes] = useState<JobType[]>(prev.jobTypes ?? (seekerType === 'student' ? ['internship'] : ['full_time']));
  const [countries, setCountries] = useState<string[]>(prev.countries ?? (state.defaults.country ? [state.defaults.country] : []));
  const [cities, setCities] = useState<CityRow[]>((prev.locations ?? []).filter((l) => !!l.city));
  const [cityDraft, setCityDraft] = useState<Record<string, string>>({});
  const [remoteOk, setRemoteOk] = useState<boolean>(prev.remoteOk ?? true);
  const [sponsorship, setSponsorship] = useState<Record<string, Sponsorship>>(prev.needsSponsorship ?? {});
  // Messages are derived from the fields as they are now, so each one goes
  // away the moment its field is valid (they used to stay until the next
  // press of Next). `attempted`: Next was pressed with something missing.
  const [attempted, setAttempted] = useState(false);
  const [cityLimitHit, setCityLimit] = useState(false);
  const errors = {
    titles: attempted && !titles.length ? t('functionsRequired') : null,
    jobTypes: attempted && !jobTypes.length ? t('jobTypesRequired') : null,
    countries: attempted && !countries.length ? t('countriesRequired') : null,
  };

  const real = countries.filter((c) => c !== 'REMOTE');
  // "Up to N cities" only while the list is still full (a removed city, or a removed country's cities, clears it).
  const cityLimit = cityLimitHit && cities.filter((c) => countries.includes(c.country)).length >= LIMITS.cities;
  const snapshotTitle = titles.find((x) => !!x.taxonomyId) ?? null;
  const snapshotCountry = real[0] ?? null;
  const snapshotCity = useMemo(() => cities.find((c) => c.country === snapshotCountry)?.city ?? null, [cities, snapshotCountry]);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  function addCity(country: string) {
    const city = (cityDraft[country] ?? '').trim();
    if (!city) return;
    if (cities.length >= LIMITS.cities) {
      setCityLimit(true);
      return;
    }
    if (cities.some((c) => c.country === country && c.city.toLowerCase() === city.toLowerCase())) return;
    setCities([...cities, { country, city, label: `${city}, ${tc(country)}` }]);
    setCityDraft({ ...cityDraft, [country]: '' });
  }

  function body() {
    const kept = cities.filter((c) => countries.includes(c.country));
    const needs = Object.fromEntries(Object.entries(sponsorship).filter(([c]) => real.includes(c)));
    return {
      jobFunctions: titles.map((x) => (x.taxonomyId ? { taxonomyId: x.taxonomyId, label: x.label } : { label: x.label })),
      jobTypes,
      countries,
      ...(kept.length ? { locations: kept } : {}),
      remoteOk,
      ...(Object.keys(needs).length ? { needsSponsorship: needs } : {}),
    };
  }

  /** Skip keeps whatever was entered; empty lists are left out so they never stand in for an answer. */
  function skipBody(b: ReturnType<typeof body>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(b).filter(([, v]) => !(Array.isArray(v) && v.length === 0)));
  }

  function next() {
    setAttempted(true);
    if (!titles.length || !jobTypes.length || !countries.length) return;
    save(body());
  }

  const branch = state.branch;
  return (
    <StepFrame
      title={branch === 'explore' ? t('titleExplore') : t('titleUrgent')}
      position={position}
      busy={busy}
      error={error}
      onBack={onBack}
      onLeave={onLeave}
      onSkip={() => save(skipBody(body()), { skip: true })}
      onNext={next}
      aside={
        <MarketSnapshotPanel
          taxonomyId={snapshotTitle?.taxonomyId ?? null}
          title={snapshotTitle?.label ?? null}
          country={snapshotCountry}
          countryLabel={snapshotCountry ? tc(snapshotCountry) : null}
          city={snapshotCity}
        />
      }
    >
      <TitlePicker value={titles} onChange={setTitles} error={errors.titles} />

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('jobTypesLabel')}</legend>
        <div className={styles.chips}>
          {JOB_TYPES.map((v) => (
            <button key={v} type="button" aria-pressed={jobTypes.includes(v)} className={styles.chip} onClick={() => setJobTypes(toggle(jobTypes, v))}>
              {t(`jobTypes.${v}`)}
            </button>
          ))}
        </div>
        {errors.jobTypes ? <p className={styles.fieldError} role="alert">{errors.jobTypes}</p> : null}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('countriesLabel')}</legend>
        <div className={styles.chips}>
          {MVP_COUNTRIES.map((c) => (
            <button key={c} type="button" aria-pressed={countries.includes(c)} className={styles.chip} onClick={() => setCountries(toggle(countries, c))}>
              {tc(c)}
            </button>
          ))}
        </div>
        {errors.countries ? <p className={styles.fieldError} role="alert">{errors.countries}</p> : null}
      </fieldset>

      {real.map((country) => {
        const mine = cities.filter((c) => c.country === country);
        const name = tc(country);
        return (
          <section key={country} className={styles.countryBlock} aria-label={name}>
            <h2 className={styles.countryTitle}>{t('citiesLabel', { country: name })}</h2>
            <div className={styles.chips}>
              {mine.length === 0 ? <span className={styles.chip} aria-pressed="true">{t('anywhereIn', { country: name })}</span> : null}
              {mine.map((c) => (
                <span key={c.city} className={styles.chip} aria-pressed="true">
                  {c.city}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={t('remove', { label: c.city })}
                    onClick={() => {
                      setCities(cities.filter((x) => x !== c));
                      setCityLimit(false);
                    }}
                  >
                    <IconX size={14} />
                  </button>
                </span>
              ))}
            </div>
            <div className={styles.row}>
              <label className={styles.srOnly} htmlFor={`city-${country}`}>
                {t('citiesLabel', { country: name })}
              </label>
              <input
                id={`city-${country}`}
                className={`${styles.input} ${styles.rowGrow}`}
                placeholder={t('cityPlaceholder')}
                value={cityDraft[country] ?? ''}
                onChange={(e) => setCityDraft({ ...cityDraft, [country]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCity(country);
                  }
                }}
              />
              <button type="button" className={styles.chip} onClick={() => addCity(country)}>
                {t('addCity')}
              </button>
            </div>
            <fieldset className={styles.fieldset}>
              <legend className={styles.label}>{t('sponsorshipLabel', { country: name })}</legend>
              <div className={styles.chips} role="radiogroup" aria-label={t('sponsorshipLabel', { country: name })}>
                {SPONSORSHIP_ANSWERS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={sponsorship[country] === a}
                    className={styles.chip}
                    onClick={() => setSponsorship({ ...sponsorship, [country]: a })}
                  >
                    {t(`sponsorship.${a}`)}
                  </button>
                ))}
              </div>
            </fieldset>
          </section>
        );
      })}
      {cityLimit ? <p className={styles.fieldError} role="alert">{t('tooManyCities')}</p> : null}

      <label className={styles.check}>
        <input type="checkbox" checked={remoteOk} onChange={(e) => setRemoteOk(e.target.checked)} />
        {t('remoteOk')}
      </label>
    </StepFrame>
  );
}
