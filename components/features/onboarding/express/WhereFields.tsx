'use client';

// "Where do you want to work?" on the start flow's second screen: the same
// controls, labels and rules as the long "What job do you want next?" screen
// (../steps/BasicsStep.tsx) — countries (the MVP set and Remote anywhere),
// cities per country (up to 5 in total; "Anywhere in {country}" when none),
// the work-permit question for each country, and "Include remote jobs" —
// with the values held by the caller.
//
// One difference, for a phone: once a place is chosen, the other countries
// fold behind "Add another place", so the screen starts short.

import { useId, useState, type Ref } from 'react';
import { useTranslations } from 'next-intl';

import { IconX } from '../../../v3/primitives/Iconset';
import { LIMITS, MVP_COUNTRIES, SPONSORSHIP_ANSWERS } from '../options';
import styles from '../onboarding.module.css';
import x from './express.module.css';
import { toggled, type CityRow, type ExpressForm } from './model';

export type WhereValue = Pick<ExpressForm, 'countries' | 'cities' | 'remoteOk' | 'sponsorship'>;

export interface WhereFieldsProps {
  value: WhereValue;
  onChange: (patch: Partial<WhereValue>) => void;
  /** "Pick at least one place.", when the screen was sent without one. */
  error?: string | null;
  /** The countries group, so the screen can move focus to it. */
  groupRef?: Ref<HTMLFieldSetElement>;
}

export function WhereFields({ value, onChange, error, groupRef }: WhereFieldsProps) {
  const t = useTranslations('onboarding.basics');
  const tc = useTranslations('onboarding.countries');
  const te = useTranslations('onboarding.express.check');
  const id = useId();
  const { countries, cities, remoteOk, sponsorship } = value;
  const [cityDraft, setCityDraft] = useState<Record<string, string>>({});
  const [cityLimitHit, setCityLimit] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const real = countries.filter((c) => c !== 'REMOTE');
  // With nothing chosen there is nothing to fold: every place is offered.
  const expanded = showAll || countries.length === 0;
  const offered = expanded ? MVP_COUNTRIES : MVP_COUNTRIES.filter((c) => countries.includes(c));
  // "Up to 5 cities" only while the list is still full.
  const cityLimit = cityLimitHit && cities.filter((c) => countries.includes(c.country)).length >= LIMITS.cities;
  const errorId = `${id}-places-error`;
  const listId = `${id}-places`;

  function addCity(country: string) {
    const city = (cityDraft[country] ?? '').trim();
    if (!city) return;
    if (cities.length >= LIMITS.cities) {
      setCityLimit(true);
      return;
    }
    if (cities.some((c) => c.country === country && c.city.toLowerCase() === city.toLowerCase())) return;
    const row: CityRow = { country, city, label: `${city}, ${tc(country)}` };
    onChange({ cities: [...cities, row] });
    setCityDraft({ ...cityDraft, [country]: '' });
  }

  return (
    <>
      <fieldset className={styles.fieldset} ref={groupRef} aria-describedby={error ? errorId : undefined}>
        <legend className={styles.legend}>{t('countriesLabel')}</legend>
        <div className={styles.chips} id={listId}>
          {offered.map((c) => (
            <button key={c} type="button" aria-pressed={countries.includes(c)} className={styles.chip} onClick={() => onChange({ countries: toggled(countries, c) })}>
              {tc(c)}
            </button>
          ))}
        </div>
        {countries.length > 0 ? (
          <button type="button" className={x.textBtn} aria-expanded={expanded} aria-controls={listId} onClick={() => setShowAll(!showAll)}>
            {expanded ? te('chosenPlaces') : te('otherPlaces')}
          </button>
        ) : null}
        {error ? (
          <p id={errorId} className={styles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>

      {real.map((country) => {
        const mine = cities.filter((c) => c.country === country);
        const name = tc(country);
        const cityId = `${id}-city-${country}`;
        return (
          <section key={country} className={styles.countryBlock} aria-label={name}>
            <h2 className={styles.countryTitle}>{t('citiesLabel', { country: name })}</h2>
            <div className={styles.chips}>
              {mine.length === 0 ? <span className={x.tag}>{t('anywhereIn', { country: name })}</span> : null}
              {mine.map((c) => (
                <span key={c.city} className={x.tag}>
                  {c.city}
                  <button
                    type="button"
                    className={x.tagRemove}
                    aria-label={t('remove', { label: c.city })}
                    onClick={() => {
                      onChange({ cities: cities.filter((row) => row !== c) });
                      setCityLimit(false);
                    }}
                  >
                    <IconX size={14} />
                  </button>
                </span>
              ))}
            </div>
            <div className={styles.row}>
              <label className={styles.srOnly} htmlFor={cityId}>
                {t('citiesLabel', { country: name })}
              </label>
              <input
                id={cityId}
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
                    onClick={() => onChange({ sponsorship: { ...sponsorship, [country]: a } })}
                  >
                    {t(`sponsorship.${a}`)}
                  </button>
                ))}
              </div>
            </fieldset>
          </section>
        );
      })}
      {cityLimit ? (
        <p className={styles.fieldError} role="alert">
          {t('tooManyCities')}
        </p>
      ) : null}

      <label className={styles.check}>
        <input type="checkbox" checked={remoteOk} onChange={(e) => onChange({ remoteOk: e.target.checked })} />
        {t('remoteOk')}
      </label>
    </>
  );
}
