'use client';

// PlanPicker — the in-app plan sheet (PRODUCT_PLAN.md §6.3, F-BILL-02;
// TASK_PLAN.md WP-21b). Rules it enforces:
//
//   - Prices and labels come only from `GET /billing/plans` (D3, D6): every
//     plan of either brand arrives with its amount (the catalog default or an
//     override), and the labels beside it are computed from those amounts by
//     `displayPrice`, the same function /pricing uses. A row that cannot be
//     chosen says "Not available yet" and cannot be bought. A plan the API
//     sends with no amount is not listed (nothing here invents a price or
//     says that one is missing).
//   - What can be paid with also comes from that response, never from the
//     brand: `checkout.rails` lists the rails that can charge now, in the
//     order to offer them. One rail: "Continue" uses it. Two: the buyer picks,
//     and the first one listed is the default (GoApply: Alipay first, WeChat
//     Pay second and only when it is set up). `paymentsOpen: false` (no rail
//     can charge, or payments are switched off) keeps the prices on the page
//     and shows one "payment is not open yet" note; nothing can be bought.
//     On RoboApply that is a deployment whose card rail is not ready (the
//     server then sends every plan as not on sale, so every row carries the
//     "Not available yet" tag too); on GoApply one without its rail's
//     credential, or with payments switched off.
//   - One checkout attempt = one `Idempotency-Key` (`useCheckoutAttempt`): a
//     double click sends the same key, so one payment page opens; a new key
//     is made when the sheet opens, when the plan, an acknowledgement box or
//     the way to pay changes, and after a failed call.
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
//   - The 7-day pass says "same price as weekly billing" only while the two
//     amounts the API sent are equal (`samePriceAsWeeklyBilling`).
//   - GoApply passes carry the mainland line 一次性付款 · 到期不自动续费 with
//     the pass's own day count (`billingCn.pricing.passNote`).
//   - Only what is shown can be bought: the selection is resolved from the
//     rendered options, so a hidden plan can never enable "Continue".
//   - A Pro subscriber manages renewal in the payment portal; once they have
//     cancelled (or asked for one by link) the one-time passes are offered.
//     A pass they hold can be bought again; only a subscription is "Your plan".
//   - WeChat Pay chosen: "Continue" opens the WeChat Pay sheet for the pass
//     or pack — that sheet owns the agreement box, the code and the result. A
//     payment code is only ever drawn there, as a QR code: a `weixin://` link
//     is never used as an image address. Every other rail answers a payment
//     page to open.
//   - A one-time pass says so on its row, with its day count. Student plans
//     are listed only for a verified student, on either brand: the server
//     sends them to nobody else, so the list is asked for again once the
//     buyer verifies on this page.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { PriceReference, PriceReferenceCountry } from '../market/PriceReference';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { QUARTERLY_SWITCH, displayPrice, requiresWithdrawalWaiver, samePriceAsWeeklyBilling } from '../../../lib/pricing';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { useStudentStatus } from '../account-v2';
import { WechatPaySheet, sellableCnPlan, useWechatPayAvailable } from '../billing-cn';
import type { CatalogPlan } from '../../../lib/api/credits';
import { initialSelection, monthlyPlan, plansExtras, usePlans, visiblePlans } from '../../../hooks/credits/usePlans';
import { checkoutRedirectUrl, useCheckoutAttempt, usePlanCheckout } from '../../../hooks/credits/useBillingActions';
import { useSubscriptionState } from '../../../hooks/credits/useSubscriptionState';
import { useVisitorCountry } from '../../../hooks/credits/useVisitorCountry';
import { useCredits } from '../../../hooks/shared/useCredits';
import { cn } from '../../../lib/utils';
import { SwitchQuoteSheet } from './SwitchQuoteSheet';
import { money, planNameKey, pricePeriod } from './labels';
import styles from './credits.module.css';

/** A rail `GET /billing/plans` may list in `checkout.rails`. */
export type CheckoutRail = 'stripe' | 'alipay' | 'wechatpay';

/**
 * The rails to offer, in the server's order (the first is the default).
 * WeChat Pay needs its own sheet, so it is offered only while this browser
 * can open it (`wechatPayAvailable`); every other listed rail is offered as
 * the server sent it. Unknown values are dropped.
 */
export function offeredRails(rails: readonly string[] | null | undefined, wechatPayAvailable: boolean): CheckoutRail[] {
  const out: CheckoutRail[] = [];
  for (const r of rails ?? []) {
    if (r !== 'stripe' && r !== 'alipay' && r !== 'wechatpay') continue;
    if (r === 'wechatpay' && !wechatPayAvailable) continue;
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

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
  const tv = useTranslations('accountV2');
  // The CN rails' own refusals (the per-user order limit) are worded once, there.
  const tc = useTranslations('billingCn');
  const locale = useLocale();
  const brand = useBrand();
  const studentFlag = useFlag('student');
  const student = useStudentStatus();
  // Student plans are offered only to a verified student (the server refuses the rest).
  const studentEnabled = studentFlag && student.data?.verified === true;
  const plansQ = usePlans();
  const sub = useSubscriptionState();
  const credits = useCredits();
  const checkout = usePlanCheckout();
  const attempt = useCheckoutAttempt();
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
  /** The plan being bought in the WeChat Pay sheet. */
  const [wechatFor, setWechatFor] = useState<CatalogPlan | null>(null);
  const wechatPay = useWechatPayAvailable();
  /** The rail the buyer picked; null = the first one the server lists. */
  const [railChoice, setRailChoice] = useState<CheckoutRail | null>(null);

  // The server lists student plans only for a verified student. A buyer who
  // verifies while this sheet is open still holds the list from before, so
  // it is asked for once more (once: a server with the capability off keeps
  // answering without them).
  const listsStudentPlans = plansQ.data?.plans?.some((p) => p.requiresFlag === 'student') ?? false;
  const askedForStudentPlans = useRef(false);
  const havePlans = !!plansQ.data;
  const refetchPlans = plansQ.refetch;
  useEffect(() => {
    if (!studentEnabled || !havePlans || listsStudentPlans || askedForStudentPlans.current) return;
    askedForStudentPlans.current = true;
    void refetchPlans();
  }, [studentEnabled, havePlans, listsStudentPlans, refetchPlans]);

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

  // A changed plan, acknowledgement box or way to pay is a new checkout attempt.
  const renewAttempt = attempt.renew;
  useEffect(() => {
    renewAttempt();
  }, [renewAttempt, selected, autoRenewAck, waiver, railChoice]);

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
    if (p.kind === 'pass') return sub.cancelAtPeriodEnd || p.key === requestedPlan;
    // Only the quarterly plan asked for by the one quarterly suggestion is
    // offered, as a switch; every other change goes through the payment portal.
    return !sub.cancelAtPeriodEnd && p.key === requestedPlan && !!sub.planKey && QUARTERLY_SWITCH[sub.planKey] === p.key;
  });
  const packs = plans.filter((p) => p.kind === 'pack');
  const offered = [...proPlans, ...packs];
  if (offered.length === 0) {
    return <p className={styles.body}>{t('planSheet.empty')}</p>;
  }

  // How this purchase can be paid: what the server says can charge now.
  const rails = offeredRails(plansQ.data.checkout?.rails, wechatPay.available);
  const rail: CheckoutRail | null = railChoice && rails.includes(railChoice) ? railChoice : (rails[0] ?? null);
  // No rail that can charge, or the server says payments are closed: prices stay, nothing is bought.
  const paymentsOpen = rails.length > 0 && plansQ.data.paymentsOpen !== false;

  // Only a rendered option can be the plan being bought.
  const plan = offered.find((p) => p.key === selected) ?? null;
  // Passes and packs can be bought again; only a running subscription is "Your plan".
  const isCurrent = (p: CatalogPlan) => p.kind === 'subscription' && sub.profile === 'pro' && !sub.legacy && sub.planKey === p.key;
  const legacySwitch = !!plan && plan.kind === 'subscription' && (sub.legacy || onProSubscription);
  const needsAck = !!plan && plan.requiresAutoRenewAck;
  const period = plan ? pricePeriod(plan) : 'once';
  const shown = plan ? displayPrice(plan, monthly) : null;
  const price = shown ? money(locale, shown.amountMinor, shown.currency) : '—';
  // WeChat Pay sells one-time passes and packs only.
  const viaWechat = rail === 'wechatpay';
  const wechatCanSell = !viaWechat || (!!plan && sellableCnPlan(plans, plan.key) !== null);
  const canContinue =
    !!plan &&
    plan.sellable &&
    paymentsOpen &&
    rail !== null &&
    wechatCanSell &&
    !isCurrent(plan) &&
    (!needsAck || autoRenewAck) &&
    (brand.market !== 'intl' || countryResolved) &&
    !checkout.isPending;

  function onContinue() {
    if (!plan || !canContinue || rail === null) return;
    if (legacySwitch) {
      setQuoteFor(plan);
      return;
    }
    if (rail === 'wechatpay') {
      setWechatFor(plan);
      return;
    }
    const body = {
      planKey: plan.key,
      autoRenewAck: needsAck ? autoRenewAck : undefined,
      withdrawalWaiver: showWaiver ? waiver : undefined,
      next: checkoutReturnPath(plan, credits.data?.practice?.balance ?? null),
      cancelNext: CHECKOUT_CANCEL_PATH,
    };
    checkout.mutate(
      // The same request keeps its key; anything that changes it gets a new one.
      { rail, ...body, attemptKey: attempt.keyFor({ rail, ...body }) },
      {
        onSuccess: (res) => {
          const url = checkoutRedirectUrl(res);
          if (url) navigate(url);
        },
        // A failed call (a refusal, a provider error, a key the provider saw
        // with other parameters) ends this attempt: the next click is a new one.
        onError: () => attempt.renew(),
      },
    );
  }

  const renderOption = (p: CatalogPlan) => {
    const name = planNameKey(brand.id, p.key);
    const current = isCurrent(p);
    const disabled = !p.sellable || current;
    const per = pricePeriod(p);
    const d = displayPrice(p, monthly);
    const amount = money(locale, d.amountMinor, d.currency);
    const weekly = d.monthlyEquivalentMinor;
    const save = d.savingsPercent;
    // In the currency shown: the TWD percentage next to a TWD price, never the USD one.
    const studentPct = d.studentDiscountPercent;
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
          {weekly !== null ? <span className={styles.muted}>{t('monthlyEquivalent', { price: money(locale, weekly, d.currency) })}</span> : null}
          {save !== null ? <span className={styles.tag}>{t('save', { pct: save })}</span> : null}
          {studentPct !== null ? <span className={styles.tag}>{tv('plans.studentTag', { pct: studentPct })}</span> : null}
          {p.kind === 'pass' && p.passDays ? (
            <span className={styles.muted} data-pass-note="">
              {/* Mainland passes carry the market's own line: one-time payment, no auto-renewal. The day count is the pass's own. */}
              {brand.market === 'cn' ? tc('pricing.passNote', { days: p.passDays }) : t('passNote', { days: p.passDays })}
            </span>
          ) : null}
          {samePriceAsWeeklyBilling(p, plansQ.data?.plans) ? (
            <span className={styles.muted} data-same-price-as-weekly="">
              {t('pricing.samePriceAsWeekly')}
            </span>
          ) : null}
          {p.kind === 'pack' && p.practice && p.practice.validMonths ? (
            <span className={styles.muted}>{t('packNote', { credits: p.practice.credits, months: p.practice.validMonths })}</span>
          ) : null}
          {p.kind === 'subscription' ? <span className={styles.muted}>{t('renewsNote', { period: per })}</span> : null}
          {d.local ? <span className={styles.muted}>{tv('plans.localPrice')}</span> : null}
          {!d.local && p.currency === 'USD' && p.amountMinor !== null ? <PriceReference amountMinor={p.amountMinor} currency="USD" /> : null}
          {current ? <span className={styles.tag}>{t('planSheet.yourPlan')}</span> : null}
          {/* A row that is off sale says so, whether it is one plan or all of them; when no payment can open at all the sheet also says that once, below. */}
          {!p.sellable && !current ? <span className={styles.muted} data-not-available="">{t('planSheet.notAvailable')}</span> : null}
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

        {paymentsOpen && rails.length > 1 ? (
          <fieldset className={styles.fieldset} data-testid="rail-chooser">
            <legend className={styles.legend}>{t('planSheet.railGroup')}</legend>
            <div className={styles.options}>
              {rails.map((r) => (
                <label key={r} className={cn(styles.option, rail === r && styles.optionSelected)} data-rail={r}>
                  <input type="radio" name={`${groupId}-rail`} value={r} checked={rail === r} onChange={() => setRailChoice(r)} />
                  <span className={styles.optionBody}>
                    <span className={styles.h3}>{t(`planSheet.rails.${r}`)}</span>
                    <span className={styles.muted}>{t(`planSheet.railHint.${r}`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {!paymentsOpen ? (
          <p className={styles.notice} role="status" data-testid="payments-not-open">
            {t('planSheet.notOpen')}
          </p>
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
            {apiErrorCode(checkout.error) === 'student_verification_required'
              ? tv('plans.studentRequired')
              : apiErrorCode(checkout.error) === 'rate_limited'
                ? tc('errors.tooMany')
                : t('planSheet.error')}
          </p>
        ) : null}
        {/* An answer with no page to open (a payment code or in-app cashier
            parameters, which only the WeChat Pay sheet can use): say plainly
            that the payment page did not open. Nothing was paid. */}
        {checkout.isSuccess && !checkoutRedirectUrl(checkout.data) ? (
          <p className={styles.error} role="alert">
            {t('planSheet.error')}
          </p>
        ) : null}
        {plan?.promotionCodes && !legacySwitch ? <p className={styles.muted}>{tv('plans.promotionCode')}</p> : null}
        <div className={styles.actions}>
          <Btn variant="primary" disabled={!canContinue} onClick={onContinue} aria-busy={checkout.isPending || undefined}>
            {checkout.isPending ? t('planSheet.continuing') : legacySwitch ? t('planSheet.switchContinue') : t('planSheet.continue')}
          </Btn>
        </div>

        {wechatFor ? (
          <WechatPaySheet
            open
            planKey={wechatFor.key}
            onClose={() => setWechatFor(null)}
            onPaid={() => {
              // The server already has the payment: show its new state.
              sub.refetch();
              void credits.refetch();
            }}
            navigate={navigate}
          />
        ) : null}

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
