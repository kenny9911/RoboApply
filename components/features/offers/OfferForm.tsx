'use client';

// OfferForm — the user's own offer numbers (WP-64). Every brand: base pay and
// its period, currency, yearly bonus amount, bonus as written, signing bonus,
// equity as written, location, start date, reply-by date, notes. GoApply adds
// 薪数, 年终 as written, 五险一金 base, 公积金 %, 户口.
//
// Text fields are kept as written and never added into totals; the form says
// so next to them.

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { bodyFrom, type OfferBody, type OfferFormError, type OfferFormState, type OfferPeriodValue } from './shared';
import styles from './offers.module.css';

export interface OfferFormProps {
  initial: OfferFormState;
  market: 'intl' | 'cn';
  saving: boolean;
  onSave: (body: OfferBody) => void;
  onCancel: () => void;
}

const PERIODS: OfferPeriodValue[] = ['year', 'month', 'hour'];

export function OfferForm({ initial, market, saving, onSave, onCancel }: OfferFormProps) {
  const t = useTranslations('offers.form');
  const uid = useId();
  const [f, setF] = useState<OfferFormState>(initial);
  const [error, setError] = useState<OfferFormError | null>(null);
  const set = <K extends keyof OfferFormState>(key: K, value: OfferFormState[K]) => {
    setError(null);
    setF((prev) => ({ ...prev, [key]: value }));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const out = bodyFrom(f, market);
    if ('error' in out) {
      setError(out.error);
      return;
    }
    onSave(out.body);
  }

  const hinted = (key: string, label: string, control: (describedBy: string | undefined) => ReactNode, hint?: string) => {
    const hintId = hint ? `${uid}-${key}-hint` : undefined;
    return (
      <div className={styles.field}>
        <label className={styles.field}>
          <span className={styles.label}>{label}</span>
          {control(hintId)}
        </label>
        {hint ? (
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        ) : null}
      </div>
    );
  };
  const text = (key: 'bonus' | 'equity' | 'location' | 'yearEndBonus', label: string, hint?: string) =>
    hinted(
      key,
      label,
      (describedBy) => (
        <input className={styles.input} maxLength={key === 'location' ? 120 : 200} value={f[key]} onChange={(e) => set(key, e.target.value)} aria-describedby={describedBy} />
      ),
      hint,
    );
  const amount = (key: 'base' | 'bonusAmount' | 'signingBonus' | 'socialInsuranceBase' | 'hoursPerWeek' | 'salaryMonths' | 'housingFundPercent', label: string, hint?: string) =>
    hinted(
      key,
      label,
      (describedBy) => (
        <input
          className={styles.input}
          inputMode="decimal"
          value={f[key]}
          onChange={(e) => set(key, e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={error !== null && errorField(error) === key}
        />
      ),
      hint,
    );

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-label={t('aria')}>
      <div className={styles.grid}>
        {amount('base', t('base'))}
        <label className={styles.field}>
          <span className={styles.label}>{t('period')}</span>
          <select className={styles.select} value={f.period} onChange={(e) => set('period', e.target.value as OfferPeriodValue)}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {t(`period_${p}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('currency')}</span>
          <input
            className={styles.input}
            maxLength={3}
            autoCapitalize="characters"
            value={f.currency}
            onChange={(e) => set('currency', e.target.value.toUpperCase())}
            aria-invalid={error === 'currency'}
          />
        </label>
        {f.period === 'hour' ? amount('hoursPerWeek', t('hours'), t('hours_hint')) : null}
        {market === 'cn' && f.period === 'month' ? amount('salaryMonths', t('salary_months'), t('salary_months_hint')) : null}
        {amount('bonusAmount', t('bonus_amount'), t('bonus_amount_hint'))}
        {text('bonus', t('bonus_text'), t('bonus_text_hint'))}
        {market === 'cn' ? text('yearEndBonus', t('year_end'), t('year_end_hint')) : null}
        {amount('signingBonus', t('signing'), t('signing_hint'))}
        {text('equity', t('equity'), t('equity_hint'))}
      </div>

      {market === 'cn' ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{t('benefits')}</legend>
          <div className={styles.grid}>
            {amount('socialInsuranceBase', t('si_base'))}
            {amount('housingFundPercent', t('hf_percent'), t('hf_percent_hint'))}
            <label className={styles.field}>
              <span className={styles.label}>{t('hukou')}</span>
              <select className={styles.select} value={f.hukou} onChange={(e) => set('hukou', e.target.value as OfferFormState['hukou'])}>
                <option value="">{t('hukou_unknown')}</option>
                <option value="yes">{t('yes')}</option>
                <option value="no">{t('no')}</option>
              </select>
            </label>
          </div>
        </fieldset>
      ) : null}

      <div className={styles.grid}>
        {text('location', t('location'))}
        <label className={styles.field}>
          <span className={styles.label}>{t('start')}</span>
          <input className={styles.input} type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('deadline')}</span>
          <input className={styles.input} type="date" value={f.deadline} onChange={(e) => set('deadline', e.target.value)} />
        </label>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>{t('notes')}</span>
        <textarea className={styles.textarea} rows={3} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
      </label>

      {error ? (
        <p className={styles.error} role="alert">
          {t(`error.${error}`)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Btn type="submit" variant="primary" disabled={saving}>
          {saving ? t('saving') : t('save')}
        </Btn>
        <Btn variant="ghost" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Btn>
      </div>
    </form>
  );
}

function errorField(e: OfferFormError): keyof OfferFormState | null {
  switch (e) {
    case 'base':
      return 'base';
    case 'salary_months':
      return 'salaryMonths';
    case 'housing_fund_percent':
      return 'housingFundPercent';
    case 'hours':
      return 'hoursPerWeek';
    default:
      return null;
  }
}
