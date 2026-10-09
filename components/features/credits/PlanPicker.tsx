'use client';

// PlanPicker — the in-app plan sheet (PRODUCT_PLAN.md §6.3, F-BILL-02;
// TASK_PLAN.md WP-21b). Rules it enforces:
//
//   - Prices come only from `GET /billing/plans` (D3); unpriced plans are
//     hidden, unsellable ones (GoApply before CN_PAYMENTS_ENABLED) show
//     "Not available yet" and cannot be bought.
//   - Monthly is preselected; weekly plans and passes are NEVER preselected
//     (server `defaultSelection`, re-checked here).
//   - The weekly price shows its monthly equivalent ("about $43 a month");
//     multi-month plans show "Save N%" computed from our own monthly price,
//     rounded down. No struck-through anchors, no countdowns, no offers.
//   - Auto-renewing plans need the UNTICKED box "I agree this renews
//     automatically every {period} at {price} until I cancel"; the payment
//     button stays disabled until it is ticked.
//   - EU/UK/TW buyers also see the optional withdrawal waiver ("Start now…");
//     left unticked they keep the full 14-day refund.
//   - A legacy practice-plan subscriber choosing a Pro subscription gets the
//     quote sheet (amount today, renewal price, next renewal date) before
//     anything is charged.
//   - Taiwan visitors see the TWD reference line under USD prices.
//   - Only what is shown can be bought: the selection is resolved from the
//     rendered options, so a hidden plan can never enable "Continue".
//   - A Pro subscriber manages renewal in the payment portal; once they have
//     cancelled (or asked for one by link) the one-time passes are offered.
//     A pass they hold can be bought again; only a subscription is "Your plan".

import { useEffect, useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { PriceReference, PriceReferenceCountry } from '../market/PriceReference';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { monthlyEquivalentMinor, requiresWithdrawalWaiver, savingsPercent } from '../../../lib/pricing';
import type { CatalogPlan } from '../../../lib/api/credits';
import { initialSelection, monthlyPlan, plansExtras, usePlans, visiblePlans } from '../../../hooks/credits/usePlans';
import { checkoutRedirectUrl, usePlanCheckout } from '../../../hooks/credits/useBillingActions';
import { useSubscriptionState } from '../../../hooks/credits/useSubscriptionState';
import { useVisitorCountry } from '../../../hooks/credits/useVisitorCountry';
import { useCredits } from '../../../hooks/shared/useCredits';
import { cn } from '../../../lib/utils';
import { SwitchQuoteSheet } from './SwitchQuoteSheet';
import { money, planMonths, planNameKey, pricePeriod } from './labels';
import styles from './credits.module.css';

export const CHECKOUT_RETURN_PATH = '/settings/billing/return';
export const CHECKOUT_CANCEL_PATH = '/settings/billing';

export interface PlanPickerProps {
  /**
   * The buyer's country from the edge, when a server page read it (`null` =
   * the edge sent none). Omitted (client-only surfaces such as
   * /settings#billing), it comes from the plans response or the
   * `visitorCountry` server function.
   */
  visitorCountry?: string | null;
  /**
   * A plan the user asked for by link (`?plan=`), e.g. the cancel-time 7-day
   * pass. Read once when the plans arrive; parents re-key the picker on it so
   * a new request selects again.
   */
  requestedPlan?: string | null;
  /** Browser navigation (tests inject it). */
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

/**
 * Where the payment page sends the buyer back: the return page plus what was
 * bought, so it can tell when that purchase has landed. For a practice pack
 * it carries the balance before checkout (the pack is in once it rises).
 */
export function checkoutReturnPath(plan: Pick<CatalogPlan, 'key' | 'kind'>, practiceBalance: number | null): string {
  const q = new URLSearchParams({ plan: plan.key });
  if (plan.kind === 'pack' && practiceBalance !== null && Number.isInteger(practiceBalance) && practiceBalance >= 0) {
    q.set('practiceBefore', String(practiceBalance));
  }
  return `${CHECKOUT_RETURN_PATH}?${q.toString()}`;
}

export function PlanPicker({ visitorCountry, requestedPlan, navigate = defaultNavigate }: PlanPickerProps) {
  const t = useTranslations('credits');
  const locale = useLocale();
  const brand = useBrand();
  const studentEnabled = useFlag('student');
  const plansQ = usePlans();
  const sub = useSubscriptionState();
  const credits = useCredits();
  const checkout = usePlanCheckout();
  const groupId = useId();

  const plans = useMemo(() => visiblePlans(plansQ.data?.plans, { studentEnabled }), [plansQ.data, studentEnabled]);
  const monthly = monthlyPlan(plansQ.data?.plans);
  const extras = plansExtras(plansQ.data);
  const { country, resolved: countryResolved } = useVisitorCountry(visitorCountry, extras.visitorCountry, {
    enabled: brand.market === 'intl' && !!plansQ.data,
  });
  // Unknown country → no box: left out, the buyer keeps the full 14-day refund.
  const showWaiver = brand.market === 'intl' && requiresWithdrawalWaiver(country);

  const [selected, setSelected] = useState<string | null>(null);
  const [initialised, setInitialised] = useState(false);
  const [autoRenewAck, setAutoRenewAck] = useState(false);
  const [waiver, setWaiver] = useState(false);
  const [quoteFor, setQuoteFor] = useState<CatalogPlan | null>(null);

  useEffect(() => {
    if (initialised || !plansQ.data) return;
    setSelected(initialSelection(plansQ.data, requestedPlan));
    setInitialised(true);
  }, [initialised, plansQ.data, requestedPlan]);

  // A new choice starts with both boxes unticked again.
  useEffect(() => {
    setAutoRenewAck(false);
    setWaiver(false);
  }, [selected]);

  if (plansQ.isLoading) return <p className={styles.muted} aria-busy="true">{t('planSheet.loading')}</p>;
  if (plansQ.isError || !plansQ.data) {
    return (
      <div className={styles.notice} role="alert">
        <p className={styles.body}>{t('planSheet.loadError')}</p>
        <div className={styles.actions}>
          <Btn onClick={() => void plansQ.refetch()}>{t('retry')}</Btn>
        </div>
      </div>
    );
  }

  // A Pro subscriber changes how often Pro renews in the payment portal, so
  // other subscriptions stay off this sheet for them. One-time passes are
  // offered once the subscription is cancelled, or when asked for by link
  // (the cancel-time "7-day pass instead?").
  const onProSubscription = sub.autoRenews && !sub.legacy && sub.profile === 'pro';
  const proPlans = plans.filter((p) => {
    if (p.kind !== 'subscription' && p.kind !== 'pass') return false;
    if (!onProSubscription) return true;
    return p.kind === 'pass' && (sub.cancelAtPeriodEnd || p.key === requestedPlan);
  });
  const packs = plans.filter((p) => p.kind === 'pack');
  const offered = [...proPlans, ...packs];
  if (offered.length === 0) {
    return <p className={styles.body}>{brand.market === 'cn' ? t('planSheet.emptyCn') : t('planSheet.empty')}</p>;
  }

  // Only a rendered option can be the plan being bought.
  const plan = offered.find((p) => p.key === selected) ?? null;
  // Passes and packs can be bought again; only a running subscription is "Your plan".
  const isCurrent = (p: CatalogPlan) => p.kind === 'subscription' && sub.profile === 'pro' && !sub.legacy && sub.planKey === p.key;
  const legacySwitch = !!plan && sub.legacy && plan.kind === 'subscription';
  const needsAck = !!plan && plan.requiresAutoRenewAck;
  const period = plan ? pricePeriod(plan) : 'once';
  const price = plan ? money(locale, plan.amountMinor, plan.currency) : '—';
  const canContinue =
    !!plan &&
    plan.sellable &&
    !isCurrent(plan) &&
    (!needsAck || autoRenewAck) &&
    (brand.market !== 'intl' || countryResolved) &&
    !checkout.isPending;
  const rail: 'stripe' | 'alipay' = brand.market === 'cn' ? 'alipay' : 'stripe';
  const checkoutResult = checkout.data;
  const qrCodeUrl = checkoutResult && 'qrCodeUrl' in checkoutResult ? (checkoutResult.qrCodeUrl ?? null) : null;

  function onContinue() {
    if (!plan || !canContinue) return;
    if (legacySwitch) {
      setQuoteFor(plan);
      return;
    }
    checkout.mutate(
      {
        rail,
        planKey: plan.key,
        autoRenewAck: needsAck ? autoRenewAck : undefined,
        withdrawalWaiver: showWaiver ? waiver : undefined,
        next: checkoutReturnPath(plan, credits.data?.practice?.balance ?? null),
        cancelNext: CHECKOUT_CANCEL_PATH,
      },
      {
        onSuccess: (res) => {
          const url = checkoutRedirectUrl(res);
          if (url) navigate(url);
        },
      },
    );
  }

  const renderOption = (p: CatalogPlan) => {
    const name = planNameKey(brand.id, p.key);
    const current = isCurrent(p);
    const disabled = !p.sellable || current;
    const per = pricePeriod(p);
    const amount = money(locale, p.amountMinor, p.currency);
    const weekly = p.interval === 'week' ? monthlyEquivalentMinor(p.amountMinor) : null;
    const months = planMonths(p);
    const save = months ? savingsPercent(p.amountMinor, monthly?.amountMinor, months) : null;
    return (
      <label
        key={p.key}
        className={cn(styles.option, selected === p.key && styles.optionSelected, disabled && styles.optionDisabled)}
        data-plan={p.key}
      >
        <input
          type="radio"
          name={groupId}
          value={p.key}
          checked={selected === p.key}
          disabled={disabled}
          onChange={() => setSelected(p.key)}
        />
        <span className={styles.optionBody}>
          <span className={styles.h3}>{name ? t(name) : p.defaultLabel}</span>
          <span className={styles.price}>{t(`price.${per}`, { price: amount })}</span>
          {weekly !== null ? <span className={styles.muted}>{t('monthlyEquivalent', { price: money(locale, weekly, p.currency) })}</span> : null}
          {save !== null ? <span className={styles.tag}>{t('save', { pct: save })}</span> : null}
          {p.kind === 'pass' ? <span className={styles.muted}>{t('passNote', { days: p.passDays ?? 0 })}</span> : null}
          {p.kind === 'pack' && p.practice ? (
            <span className={styles.muted}>{t('packNote', { credits: p.practice.credits, months: p.practice.validMonths ?? 12 })}</span>
          ) : null}
          {p.kind === 'subscription' ? <span className={styles.muted}>{t('renewsNote', { period: per })}</span> : null}
          {p.currency === 'USD' && p.amountMinor !== null ? <PriceReference amountMinor={p.amountMinor} currency="USD" /> : null}
          {current ? <span className={styles.tag}>{t('planSheet.yourPlan')}</span> : null}
          {!p.sellable && !current ? <span className={styles.muted}>{t('planSheet.notAvailable')}</span> : null}
        </span>
      </label>
    );
  };

  return (
    <PriceReferenceCountry country={country}>
      <div className={styles.stack} id="plans" data-testid="plan-picker">
        {proPlans.length > 0 ? (
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('planSheet.proGroup')}</legend>
            <div className={styles.options}>{proPlans.map(renderOption)}</div>
          </fieldset>
        ) : null}
        {onProSubscription && !sub.cancelAtPeriodEnd ? <p className={styles.muted}>{t('planSheet.manageInPortal')}</p> : null}
        {packs.length > 0 ? (
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('planSheet.packGroup')}</legend>
            <div className={styles.options}>{packs.map(renderOption)}</div>
          </fieldset>
        ) : null}

        {plan && needsAck ? (
          <label className={styles.check}>
            <input type="checkbox" checked={autoRenewAck} onChange={(e) => setAutoRenewAck(e.target.checked)} />
            <span>{t('planSheet.autoRenewAck', { period, price })}</span>
          </label>
        ) : null}
        {plan && showWaiver ? (
          <div className={styles.stack} style={{ gap: 'var(--sp-1)' }}>
            <label className={styles.check}>
              <input type="checkbox" checked={waiver} onChange={(e) => setWaiver(e.target.checked)} />
              <span>{t('planSheet.withdrawalAck')}</span>
            </label>
            <p className={styles.muted}>{t('planSheet.withdrawalHelp')}</p>
          </div>
        ) : null}

        {checkout.isError ? (
          <p className={styles.error} role="alert">
            {t('planSheet.error')}
          </p>
        ) : null}
        {qrCodeUrl ? (
          <div className={styles.notice}>
            <p className={styles.body}>{t('planSheet.scanToPay')}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrCodeUrl} alt={t('planSheet.qrAlt')} width={200} height={200} />
          </div>
        ) : null}

        <div className={styles.actions}>
          <Btn variant="primary" disabled={!canContinue} onClick={onContinue} aria-busy={checkout.isPending || undefined}>
            {checkout.isPending ? t('planSheet.continuing') : legacySwitch ? t('planSheet.switchContinue') : t('planSheet.continue')}
          </Btn>
        </div>

        {quoteFor ? (
          <SwitchQuoteSheet
            plan={quoteFor}
            autoRenewAck={autoRenewAck}
            withdrawalWaiver={showWaiver ? waiver : undefined}
            onClose={() => setQuoteFor(null)}
          />
        ) : null}
      </div>
    </PriceReferenceCountry>
  );
}

export default PlanPicker;
