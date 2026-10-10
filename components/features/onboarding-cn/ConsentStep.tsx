'use client';

// G1 授权说明 (/onboarding/consent) — separate, unbundled consents (PIPL;
// PRODUCT_PLAN.md §4.5 G1; TASK_PLAN.md WP-31).
//
//   - The prose is the server's (GET /api/v1/public/legal/consents, WP-13);
//     its version is sent back so the record hashes exactly what was shown.
//   - Required: the agreement (用户协议 + 隐私政策), age 16+, and — while data
//     is processed outside the mainland (CN-0) — the cross-border box, whose
//     prose names every offshore processor and the US region.
//   - Nothing starts checked. AI processing is off until tapped; marketing is
//     off. 个性化推荐 has NO default: 开启 / 关闭 must be chosen before 下一步.
//   - Declining AI processing is fine: the user continues in manual mode.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { ConsentCatalogItem } from '../../../lib/api/contracts/compliance';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { Btn } from '../../v3/primitives/Btn';
import { useCnOnboardingApi } from './api';
import type { CnOnboardingStepProps } from './types';
import { StepFrame, SwitchRow, useSaveStep, useStoredAnswers } from './parts';
import { stepAnswers } from './logic';
import styles from './OnboardingCn.module.css';

export interface ConsentFormState {
  agreement: boolean;
  age: boolean;
  crossBorder: boolean;
  aiProcessing: boolean;
  personalizedRecommendation: boolean | null;
  marketing: boolean;
}

/** First visit: every box unchecked and the 个性化推荐 choice unset. */
export const INITIAL_CONSENT_STATE: Readonly<ConsentFormState> = Object.freeze({
  agreement: false,
  age: false,
  crossBorder: false,
  aiProcessing: false,
  personalizedRecommendation: null,
  marketing: false,
});

/**
 * A returning user's form, from the ledger (`granted`: true / false / null =
 * never answered). The agreement and age were required to get past G1 and
 * can only end by deleting the account, so they stay ticked.
 */
export function consentFormFromLedger(items: readonly Pick<ConsentCatalogItem, 'type' | 'granted'>[], fallback: { crossBorder: boolean }): ConsentFormState {
  const granted = (type: string) => items.find((i) => i.type === type)?.granted;
  const crossBorder = granted('pipl_cross_border');
  return {
    agreement: true,
    age: true,
    crossBorder: typeof crossBorder === 'boolean' ? crossBorder : fallback.crossBorder,
    aiProcessing: granted('ai_resume_parsing') === true,
    personalizedRecommendation: typeof granted('personalized_recommendation') === 'boolean' ? (granted('personalized_recommendation') as boolean) : null,
    marketing: granted('marketing_email') === true,
  };
}

export function proseLocale(locale: string): 'zh' | 'en' {
  return locale === 'zh' ? 'zh' : 'en';
}

export function ConsentStep({ onDone, onBack }: CnOnboardingStepProps) {
  const t = useTranslations('onboardingCn');
  const locale = useLocale();
  const brand = useBrand();
  const api = useCnOnboardingApi();
  const { answers, loaded } = useStoredAnswers();
  const [items, setItems] = useState<ConsentCatalogItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<ConsentFormState>({ ...INITIAL_CONSENT_STATE });
  const { save, saving, error, setError } = useSaveStep('consent', onDone);

  const load = useCallback(() => {
    setLoadFailed(false);
    api
      .getConsents(proseLocale(locale))
      .then((list) => setItems(list.filter((i) => i.stage === 'signup')))
      .catch(() => setLoadFailed(true));
  }, [api, locale]);
  useEffect(load, [load]);

  // Coming back to this step shows the user's current answers (never a
  // default). The optional ones come from the consent ledger, not from the
  // stored step answers: the resume gate or Settings may have changed them
  // since, and re-submitting a stale value would silently revoke or grant.
  // Until the ledger is read, 下一步 stays disabled.
  const [restore, setRestore] = useState<'none' | 'loading' | 'failed' | 'done'>('none');
  const restoreFromLedger = useCallback(() => {
    const prev = stepAnswers(answers, 'consent');
    if (prev.agreement !== true) return setRestore('none');
    setRestore('loading');
    api
      .getMyConsents(proseLocale(locale))
      .then((list) => {
        setForm(consentFormFromLedger(list, { crossBorder: prev.crossBorder === true }));
        setRestore('done');
      })
      .catch(() => setRestore('failed'));
  }, [answers, api, locale]);
  useEffect(() => {
    if (loaded) restoreFromLedger();
  }, [loaded, restoreFromLedger]);

  const byType = useMemo(() => new Map((items ?? []).map((i) => [i.type, i])), [items]);
  const crossBorderItem = byType.get('pipl_cross_border') ?? null;
  const set = (patch: Partial<ConsentFormState>) => setForm((f) => ({ ...f, ...patch }));

  const missingRequired = !form.agreement || !form.age || (crossBorderItem !== null && !form.crossBorder);
  const missingChoice = form.personalizedRecommendation === null;
  const restoring = restore === 'loading' || restore === 'failed';
  const disabled = !items || restoring || missingRequired || missingChoice;
  const hint = !items ? null : missingRequired ? t('consent.needRequired') : missingChoice ? t('consent.needChoice') : null;

  async function submit() {
    if (!items || form.personalizedRecommendation === null) return;
    const ok = await save({
      agreement: form.agreement && form.age,
      ...(crossBorderItem ? { crossBorder: form.crossBorder } : {}),
      aiProcessing: form.aiProcessing,
      personalizedRecommendation: form.personalizedRecommendation,
      marketing: form.marketing,
      proseVersion: items[0]?.proseVersion ?? '',
    });
    if (!ok) load(); // The text may have changed: reload it before the user tries again.
  }

  const prose = (type: string) => byType.get(type)?.prose ?? '';

  return (
    <StepFrame
      title={t('consent.title')}
      subtitle={t('consent.subtitle')}
      onBack={onBack}
      nextDisabled={disabled}
      disabledHint={hint}
      saving={saving}
      error={error}
      onSubmit={() => {
        setError(null);
        void submit();
      }}
    >
      {restore === 'failed' ? (
        <div className={styles.notice} role="alert">
          <p className={styles.subtitle}>{t('consent.restoreError')}</p>
          <div>
            <Btn onClick={restoreFromLedger}>{t('common.retry')}</Btn>
          </div>
        </div>
      ) : null}
      {loadFailed ? (
        <div className={styles.notice} role="alert">
          <p className={styles.subtitle}>{t('consent.loadError')}</p>
          <div>
            <Btn onClick={load}>{t('common.retry')}</Btn>
          </div>
        </div>
      ) : !items ? (
        <p className={styles.note} aria-busy="true">
          {t('common.loading')}
        </p>
      ) : (
        <>
          <fieldset className={styles.consent}>
            <legend className={styles.label}>
              {t('consent.requiredGroup')}
              <span className={styles.required}>{t('common.required')}</span>
            </legend>
            {byType.has('pipl_basic_processing') ? (
              <label className={styles.check}>
                <input type="checkbox" checked={form.agreement} onChange={(e) => set({ agreement: e.target.checked })} />
                <span>{prose('pipl_basic_processing')}</span>
              </label>
            ) : null}
            <div className={styles.links}>
              <a href={brand.legal.termsPath} target="_blank" rel="noopener">
                {t('consent.terms')}
              </a>
              <a href={brand.legal.privacyPath} target="_blank" rel="noopener">
                {t('consent.privacy')}
              </a>
            </div>
            {byType.has('age_16_plus') ? (
              <label className={styles.check}>
                <input type="checkbox" checked={form.age} onChange={(e) => set({ age: e.target.checked })} />
                <span>{prose('age_16_plus')}</span>
              </label>
            ) : null}
            {crossBorderItem ? (
              <label className={styles.check}>
                <input type="checkbox" checked={form.crossBorder} onChange={(e) => set({ crossBorder: e.target.checked })} />
                <span>{crossBorderItem.prose}</span>
              </label>
            ) : null}
          </fieldset>

          <fieldset className={styles.consent}>
            <legend className={styles.label}>{t('consent.aiTitle')}</legend>
            <SwitchRow label={t('consent.aiToggle')} checked={form.aiProcessing} onChange={(v) => set({ aiProcessing: v })} />
            <p className={styles.subtitle}>{prose('ai_resume_parsing')}</p>
            {crossBorderItem ? <p className={styles.note}>{t('consent.aiOffshore')}</p> : null}
            <div className={styles.links}>
              <a href="/legal/ai-disclosure" target="_blank" rel="noopener">
                {t('consent.aiModels')}
              </a>
            </div>
          </fieldset>

          <fieldset className={styles.consent}>
            <legend className={styles.label}>
              {t('consent.rankTitle')}
              <span className={styles.required}>{t('consent.chooseOne')}</span>
            </legend>
            <p className={styles.subtitle}>{prose('personalized_recommendation')}</p>
            <div className={styles.chips} role="radiogroup" aria-label={t('consent.rankTitle')}>
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={form.personalizedRecommendation === v}
                  className={styles.chip}
                  onClick={() => set({ personalizedRecommendation: v })}
                >
                  {v ? t('consent.rankOn') : t('consent.rankOff')}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.consent}>
            <legend className={styles.label}>{t('consent.marketingTitle')}</legend>
            <SwitchRow label={prose('marketing_email') || t('consent.marketingTitle')} checked={form.marketing} onChange={(v) => set({ marketing: v })} />
          </fieldset>

          <p className={styles.note}>{t('consent.changeLater')}</p>
        </>
      )}
    </StepFrame>
  );
}
