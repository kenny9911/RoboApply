'use client';

// G1 授权说明 (/onboarding/consent) — separate, unbundled consents (PIPL;
// PRODUCT_PLAN.md §4.5 G1; TASK_PLAN.md WP-31).
//
//   - The prose is the server's (GET /api/v1/public/legal/consents, WP-13);
//     its version is sent back so the record hashes exactly what was shown.
//     WHO processes data outside the mainland and WHERE AI requests go are
//     part of that prose, built by the server from the configuration the
//     /legal page prints. This screen adds no claim of its own about either.
//   - Required: the agreement (用户协议 + 隐私政策), age 16+, and — while data
//     is processed outside the mainland (CN-0) — the cross-border box.
//   - Asked once. The sign-up form already asks for the required three; when
//     the consent ledger holds a grant, the item is shown as given (with the
//     date) and is not asked again. G1 then asks only for the optional
//     choices. An item the ledger does not hold (another sign-up method) is
//     still a box to tick here.
//   - "You agreed to this" is said only of the text the user agreed to. When
//     the ledger's grant was given to an earlier text (`answeredTextCurrent:
//     false` — the cross-border text changed when its processor list was
//     corrected), today's text is NOT shown as agreed: the box is asked again,
//     with a line saying when the earlier version was agreed to, and the
//     server records the answer under the current text.
//   - Nothing starts checked. AI processing is off until tapped; marketing is
//     off. 个性化推荐 has NO default: 开启 / 关闭 must be chosen before 下一步.
//   - Declining AI processing is fine: the user continues in manual mode.

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import type { ConsentCatalogItem } from '../../../lib/api/contracts/compliance';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { Btn } from '../../v3/primitives/Btn';
import { IconCheck } from '../../v3/primitives/Iconset';
import { useCnOnboardingApi } from './api';
import type { CnOnboardingStepProps } from './types';
import { StepFrame, SwitchRow, useSaveStep } from './parts';
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

/** The required consents and the form field each one answers. Asked once (the server's CN_ONCE_ONLY_CONSENTS). */
export const REQUIRED_CONSENTS = [
  { type: 'pipl_basic_processing', field: 'agreement' },
  { type: 'age_16_plus', field: 'age' },
  { type: 'pipl_cross_border', field: 'crossBorder' },
] as const;
type RequiredType = (typeof REQUIRED_CONSENTS)[number]['type'];

type LedgerItem = Pick<ConsentCatalogItem, 'type' | 'granted' | 'answeredTextCurrent'>;

/** A grant of the text served now (a ledger that does not say which text was answered counts as current). */
function grantedCurrentText(item: LedgerItem | undefined): boolean {
  return item?.granted === true && item.answeredTextCurrent !== false;
}

/**
 * The form as the consent ledger has it (`granted`: true / false / null =
 * never answered). Nothing is assumed: a required consent is ticked only when
 * the ledger holds a grant of the text shown now (a grant of an earlier text
 * leaves the box empty), and 个性化推荐 stays unset until it was answered.
 */
export function consentFormFromLedger(items: readonly LedgerItem[]): ConsentFormState {
  const find = (type: string) => items.find((i) => i.type === type);
  const granted = (type: string) => find(type)?.granted;
  const personalized = granted('personalized_recommendation');
  return {
    agreement: grantedCurrentText(find('pipl_basic_processing')),
    age: grantedCurrentText(find('age_16_plus')),
    crossBorder: grantedCurrentText(find('pipl_cross_border')),
    aiProcessing: granted('ai_resume_parsing') === true,
    personalizedRecommendation: typeof personalized === 'boolean' ? personalized : null,
    marketing: granted('marketing_email') === true,
  };
}

/** Required consents the ledger already holds a grant for — of the text shown now (given on the sign-up form), with when. */
export function consentsAlreadyGiven(items: readonly (LedgerItem & Pick<ConsentCatalogItem, 'answeredAt'>)[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const { type } of REQUIRED_CONSENTS) {
    const hit = items.find((i) => i.type === type);
    if (grantedCurrentText(hit)) out.set(type, hit!.answeredAt ?? null);
  }
  return out;
}

/** Required consents the user agreed to under an EARLIER text, with when. They are asked again; today's text is never shown as the agreed one. */
export function consentsGivenToEarlierText(items: readonly (LedgerItem & Pick<ConsentCatalogItem, 'answeredAt'>)[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const { type } of REQUIRED_CONSENTS) {
    const hit = items.find((i) => i.type === type);
    if (hit?.granted === true && hit.answeredTextCurrent === false) out.set(type, hit.answeredAt ?? null);
  }
  return out;
}

export function proseLocale(locale: string): 'zh' | 'en' {
  return locale === 'zh' ? 'zh' : 'en';
}

export function ConsentStep({ step, onDone, onBack }: CnOnboardingStepProps) {
  const t = useTranslations('onboardingCn');
  const locale = useLocale();
  const format = useFormatter();
  const brand = useBrand();
  const api = useCnOnboardingApi();
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

  // The user's current answers come from the consent ledger — on a first
  // visit too: the sign-up form already recorded the required consents, and
  // asking for them a second time is the bug this prevents. The optional ones
  // are read from it as well (never from stored step answers: the resume gate
  // or Settings may have changed them since, and re-submitting a stale value
  // would silently revoke or grant). Until the ledger is read, 下一步 stays
  // disabled.
  const [ledger, setLedger] = useState<'loading' | 'failed' | 'done'>('loading');
  const [given, setGiven] = useState<Map<string, string | null>>(new Map());
  const [earlier, setEarlier] = useState<Map<string, string | null>>(new Map());
  const noteId = useId();
  const readLedger = useCallback(() => {
    setLedger('loading');
    api
      .getMyConsents(proseLocale(locale))
      .then((list) => {
        setForm(consentFormFromLedger(list));
        setGiven(consentsAlreadyGiven(list));
        setEarlier(consentsGivenToEarlierText(list));
        setLedger('done');
      })
      .catch(() => setLedger('failed'));
  }, [api, locale]);
  useEffect(readLedger, [readLedger]);

  const byType = useMemo(() => new Map((items ?? []).map((i) => [i.type, i])), [items]);
  const crossBorderItem = byType.get('pipl_cross_border') ?? null;
  const set = (patch: Partial<ConsentFormState>) => setForm((f) => ({ ...f, ...patch }));

  // The required items this deployment asks for (no cross-border box on the mainland), given or not.
  const required = REQUIRED_CONSENTS.filter((r) => byType.has(r.type));
  const missingRequired = required.some((r) => !given.has(r.type) && !form[r.field]);
  const allGiven = required.length > 0 && required.every((r) => given.has(r.type));
  const missingChoice = form.personalizedRecommendation === null;
  const disabled = !items || ledger !== 'done' || missingRequired || missingChoice;
  const hint = !items || ledger !== 'done' ? null : missingRequired ? t('consent.needRequired') : missingChoice ? t('consent.needChoice') : null;

  async function submit() {
    if (!items || form.personalizedRecommendation === null) return;
    const ok = await save({
      // True for both: ticked here, or already in the ledger for this text (the server does not record those twice).
      agreement: true,
      ...(crossBorderItem ? { crossBorder: true } : {}),
      aiProcessing: form.aiProcessing,
      personalizedRecommendation: form.personalizedRecommendation,
      marketing: form.marketing,
      proseVersion: items[0]?.proseVersion ?? '',
    });
    if (!ok) load(); // The text may have changed: reload it before the user tries again.
  }

  const prose = (type: string) => byType.get(type)?.prose ?? '';

  /** One required consent: shown as given when the ledger holds a grant of this text, else a box to tick (again, when the text changed). */
  function requiredRow(type: RequiredType) {
    const field = REQUIRED_CONSENTS.find((r) => r.type === type)!.field;
    if (!byType.has(type)) return null;
    if (given.has(type)) {
      const at = given.get(type);
      return (
        <div className={styles.given} data-consent={type} data-state="given">
          <span className={styles.givenMark} aria-hidden="true">
            <IconCheck size={14} />
          </span>
          <span className={styles.givenBody}>
            <span>{prose(type)}</span>
            <span className={styles.givenMeta}>{at ? t('consent.givenOn', { date: format.dateTime(new Date(at), { dateStyle: 'medium' }) }) : t('consent.given')}</span>
          </span>
        </div>
      );
    }
    const changed = earlier.has(type);
    const agreedAt = earlier.get(type);
    const changedNoteId = `${noteId}-${type}`;
    return (
      <>
        <label className={styles.check} data-consent={type} data-state={changed ? 'changed' : 'ask'}>
          <input type="checkbox" checked={form[field]} aria-describedby={changed ? changedNoteId : undefined} onChange={(e) => set({ [field]: e.target.checked })} />
          <span>{prose(type)}</span>
        </label>
        {changed ? (
          <p id={changedNoteId} className={styles.note} data-consent-note={type}>
            {agreedAt ? t('consent.changedSinceOn', { date: format.dateTime(new Date(agreedAt), { dateStyle: 'medium' }) }) : t('consent.changedSince')}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <StepFrame
      step={step}
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
      {ledger === 'failed' ? (
        <div className={styles.notice} role="alert">
          <p className={styles.subtitle}>{t('consent.restoreError')}</p>
          <div>
            <Btn onClick={readLedger}>{t('common.retry')}</Btn>
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
      ) : !items || ledger === 'loading' ? (
        <p className={styles.note} aria-busy="true">
          {t('common.loading')}
        </p>
      ) : (
        <>
          <fieldset className={styles.consent}>
            <legend className={styles.label}>
              {t('consent.requiredGroup')}
              {allGiven ? null : <span className={styles.required}>{t('common.required')}</span>}
            </legend>
            {allGiven ? <p className={styles.note}>{t('consent.requiredGiven')}</p> : null}
            {requiredRow('pipl_basic_processing')}
            <div className={styles.links}>
              <a href={brand.legal.termsPath} target="_blank" rel="noopener">
                {t('consent.terms')}
              </a>
              <a href={brand.legal.privacyPath} target="_blank" rel="noopener">
                {t('consent.privacy')}
              </a>
            </div>
            {requiredRow('age_16_plus')}
            {requiredRow('pipl_cross_border')}
          </fieldset>

          <fieldset className={styles.consent}>
            <legend className={styles.label}>{t('consent.aiTitle')}</legend>
            <SwitchRow label={t('consent.aiToggle')} checked={form.aiProcessing} onChange={(v) => set({ aiProcessing: v })} />
            {/* Where AI requests go is in this prose (the server writes it from the AI routing rule the /legal page prints). */}
            <p className={styles.subtitle}>{prose('ai_resume_parsing')}</p>
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
