'use client';

// O4 — Nice to have (explore branch only; PRODUCT §4.3). All optional:
// industries (≤5 of the closed list), skills (≤15, free entry), company size
// (with the "many posts don't say" note), a pay floor whose currency follows
// the first chosen country, and work arrangement. No funding/stage field (we
// have no funding data, D3).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { IconX } from '../../../v3/primitives/Iconset';
import { COMPANY_SIZES, COUNTRY_CURRENCY, CURRENCIES, INDUSTRIES, LIMITS, PAY_PERIODS, WORK_MODELS } from '../options';
import { StepFrame } from '../StepFrame';
import { answersOf, type StepScreenProps } from '../types';
import styles from '../onboarding.module.css';

type Size = (typeof COMPANY_SIZES)[number];
type Model = (typeof WORK_MODELS)[number];
type Period = (typeof PAY_PERIODS)[number];
interface Prefs {
  industries: string[];
  skills: string[];
  companySizes: Size[];
  minPay: { amount: number; currency: string; period: Period };
  workModels: Model[];
}

export function PreferencesStep({ state, save, onBack, onLeave, busy, error, position }: StepScreenProps) {
  const t = useTranslations('onboarding.preferences');
  const prev = answersOf<Prefs>(state, 'preferences');
  const firstCountry = (answersOf<{ countries: string[] }>(state, 'basics').countries ?? []).find((c) => c !== 'REMOTE');
  const [industries, setIndustries] = useState<string[]>(prev.industries ?? []);
  const [skills, setSkills] = useState<string[]>(prev.skills ?? []);
  const [skillDraft, setSkillDraft] = useState('');
  const [sizes, setSizes] = useState<Size[]>(prev.companySizes ?? ['any']);
  const [amount, setAmount] = useState<string>(prev.minPay ? String(prev.minPay.amount) : '');
  const [currency, setCurrency] = useState<string>(prev.minPay?.currency ?? (firstCountry ? (COUNTRY_CURRENCY[firstCountry] ?? 'USD') : 'USD'));
  const [period, setPeriod] = useState<Period>(prev.minPay?.period ?? 'year');
  const [models, setModels] = useState<Model[]>(prev.workModels ?? [...WORK_MODELS]);
  // Which message was raised. Whether it still SHOWS is read from the fields
  // as they are now (`problem` below), so it goes away when the field is fixed
  // instead of waiting for the next press of Next.
  const [raised, setProblem] = useState<'pay' | 'industries' | 'skills' | null>(null);

  const toggleIndustry = (id: string) => {
    if (industries.includes(id)) return setIndustries(industries.filter((x) => x !== id));
    if (industries.length >= LIMITS.industries) return setProblem('industries');
    setProblem(null);
    setIndustries([...industries, id]);
  };
  const toggleSize = (s: Size) => {
    if (s === 'any') return setSizes(['any']);
    const without = sizes.filter((x) => x !== 'any' && x !== s);
    setSizes(sizes.includes(s) ? (without.length ? without : ['any']) : [...without, s]);
  };
  const addSkill = () => {
    const v = skillDraft.trim();
    if (!v) return;
    if (skills.length >= LIMITS.skills) return setProblem('skills');
    if (!skills.some((s) => s.toLowerCase() === v.toLowerCase())) setSkills([...skills, v]);
    setSkillDraft('');
    setProblem(null);
  };

  /** The typed pay as a number: null when empty (pay is optional), NaN when it is not an amount above 0. */
  const payAmount = ((): number | null => {
    if (!amount.trim()) return null;
    const n = Number(amount.replace(/[,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : Number.NaN;
  })();
  const payInvalid = payAmount !== null && Number.isNaN(payAmount);

  const problem =
    raised === 'pay'
      ? payInvalid
        ? t('payInvalid')
        : null
      : raised === 'industries'
        ? industries.length >= LIMITS.industries
          ? t('tooManyIndustries')
          : null
        : raised === 'skills'
          ? skills.length >= LIMITS.skills
            ? t('tooManySkills')
            : null
          : null;

  function body(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    if (industries.length) out.industries = industries;
    if (skills.length) out.skills = skills;
    if (sizes.length) out.companySizes = sizes;
    if (models.length) out.workModels = models;
    if (payInvalid) return null;
    if (payAmount !== null) out.minPay = { amount: payAmount, currency, period };
    return out;
  }

  return (
    <StepFrame
      title={t('title')}
      position={position}
      busy={busy}
      error={error}
      onBack={onBack}
      onLeave={onLeave}
      onSkip={() => save(body() ?? {}, { skip: true })}
      onNext={() => {
        const b = body();
        if (!b) return setProblem('pay');
        save(b);
      }}
    >
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('industriesLabel')}</legend>
        <p className={styles.hint}>{t('industriesHint')}</p>
        <div className={styles.chips}>
          {INDUSTRIES.map((i) => (
            <button key={i.id} type="button" aria-pressed={industries.includes(i.id)} className={styles.chip} onClick={() => toggleIndustry(i.id)}>
              {t(`industries.${i.slug}`)}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('skillsLabel')}</legend>
        <p className={styles.hint}>{t('skillsHint')}</p>
        {skills.length ? (
          <div className={styles.chips}>
            {skills.map((s) => (
              <span key={s} className={styles.chip} aria-pressed="true">
                {s}
                <button type="button" className={styles.chipRemove} aria-label={t('removeSkill', { label: s })} onClick={() => setSkills(skills.filter((x) => x !== s))}>
                  <IconX size={14} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className={styles.row}>
          <label className={styles.srOnly} htmlFor="ob-skill">
            {t('skillPlaceholder')}
          </label>
          <input
            id="ob-skill"
            className={`${styles.input} ${styles.rowGrow}`}
            placeholder={t('skillPlaceholder')}
            value={skillDraft}
            onChange={(e) => setSkillDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addSkill();
              }
            }}
          />
          <button type="button" className={styles.chip} onClick={addSkill}>
            {t('addSkill')}
          </button>
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('sizesLabel')}</legend>
        <div className={styles.chips}>
          {COMPANY_SIZES.map((s) => (
            <button key={s} type="button" aria-pressed={sizes.includes(s)} className={styles.chip} onClick={() => toggleSize(s)}>
              {t(`sizes.${s}`)}
            </button>
          ))}
        </div>
        <p className={styles.hint}>{t('sizesHint')}</p>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('payLabel')}</legend>
        <div className={styles.row}>
          <div className={styles.rowGrow}>
            <label className={styles.label} htmlFor="ob-pay-amount">
              {t('payAmount')}
            </label>
            <input id="ob-pay-amount" className={styles.input} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className={styles.label} htmlFor="ob-pay-currency">
              {t('payCurrency')}
            </label>
            <select id="ob-pay-currency" className={styles.select} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={styles.label} htmlFor="ob-pay-period">
              {t('payPeriod')}
            </label>
            <select id="ob-pay-period" className={styles.select} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              {PAY_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`payPeriods.${p}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className={styles.hint}>{t('payHint')}</p>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('workModelsLabel')}</legend>
        <div className={styles.chips}>
          {WORK_MODELS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={models.includes(m)}
              className={styles.chip}
              onClick={() => setModels(models.includes(m) ? models.filter((x) => x !== m) : [...models, m])}
            >
              {t(`workModels.${m}`)}
            </button>
          ))}
        </div>
      </fieldset>
      {problem ? (
        <p className={styles.fieldError} role="alert">
          {problem}
        </p>
      ) : null}
    </StepFrame>
  );
}
