'use client';

// /pricing (both brands) — F-BILL-02, PRODUCT §6.1–§6.5; MARKET_STRATEGY §4.
//
// Every amount comes from GET /billing/plans (the plan catalog: defaults in
// code, env values as overrides), every cap from GET /support/credit-caps (the
// credit catalog), every number of the refund rules from that same plans
// response (`refundPolicy`). Nothing on this page is a number written in copy
// or in code (D3, D6). The labels beside a price ("Save N%", "about $43 a
// month", the student percentage, "same price as weekly billing") are computed
// by `displayPrice` / `samePriceAsWeeklyBilling` (lib/pricing.ts), the same
// functions the plan sheet uses, so the two surfaces print the same thing. A
// plan the API sends with no amount is not rendered: the page never says a
// price is missing. Pro caps are printed ("Up to N a day"), never "unlimited".
// No competitor prices and no competitor names.
//
// The page follows the plans API on both brands (D5, D6): GoApply lists its
// CNY passes and packs with their amounts exactly as RoboApply lists its USD
// plans. "Not open yet" shows only while the API says `paymentsOpen: false`
// (no payment rail can charge right now), never because of the brand. A plan
// that can be bought carries its button: checkout for a signed-in visitor,
// sign-up otherwise.
//
// What follows from the payment rail and the market (legitimately different):
// RoboApply's plans renew, so it prints the renewal and cancel rules and the
// four refund lines; GoApply sells one-time passes only, so each pass carries
// 一次性付款 · 到期不自动续费 with its own day count, the refund lines are the
// pass rules, and the collecting entity is printed when (and only when) the
// API names one (`brandPlansRenew`).
//
// Nothing here lists a feature the visitor can't use (R-04, D3): job-list
// rows and copy need `jobs.feed`, alert rows `jobs.alerts` and a working mail
// transport (`notify.email`), AI rows `ai.text`, and the campus calendar line
// `jobs.campusCalendar`.

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { monthlyPlan, usePlans } from '../../../hooks/credits/usePlans';
import { useAuth } from '../../../lib/auth/useAuth';
import { plansBillingFacts, type RefundPolicyFacts, type StudentOfferRow } from '../../../lib/api/account';
import type { CatalogPlan } from '../../../lib/api/credits';
import type { CreditCapsResponse } from '../../../lib/api/contracts/support';
import { useBrand } from '../../../lib/brand';
import { displayPrice, formatMoney, samePriceAsWeeklyBilling } from '../../../lib/pricing';
import { CancelFooterLink } from '../credits';
import { PriceReference } from '../market';
import { PRICING_FAQ_KEYS, brandPlansRenew, extensionStoreId } from './catalog';
import { useCreditCaps, useMarketingFlag } from './hooks';
import { Faq } from './Sections';
import { SignupLink } from './SignupLink';
import styles from './marketing.module.css';

type Period = 'week' | 'month' | 'quarter' | 'once';
function periodOf(plan: CatalogPlan): Period {
  if (plan.kind !== 'subscription') return 'once';
  return plan.interval === 'week' ? 'week' : plan.interval === 'quarter' ? 'quarter' : 'month';
}

/** Where a signed-in visitor buys a plan: the in-app plan picker with this plan selected. */
export function checkoutHref(planKey: string): string {
  return `/settings/billing?plan=${encodeURIComponent(planKey)}#plans`;
}

interface PlanCardProps {
  plan: CatalogPlan;
  /** The brand's monthly plan, the reference of "Save N%". */
  monthly: CatalogPlan | null;
  /** The 7-day pass costs exactly what weekly billing costs (computed from the API amounts). */
  samePriceAsWeekly: boolean;
  /** GET /billing/plans said no plan can be bought right now. */
  notOpen: boolean;
  signedIn: boolean;
}

function PlanCard({ plan, monthly, samePriceAsWeekly, notOpen, signedIn }: PlanCardProps) {
  const t = useTranslations('landing.pricingPage');
  const tc = useTranslations('credits');
  const tv = useTranslations('accountV2');
  const tb = useTranslations('billingCn');
  const locale = useLocale();
  const brand = useBrand();
  const period = periodOf(plan);
  // One computation for the page and the plan sheet (lib/pricing.ts).
  const shown = displayPrice(plan, monthly);
  // A plan of the catalog always has an amount; one without is not printed at all.
  if (shown.amountMinor === null) return null;
  const nameKey = `plans.${brand.id}.${plan.key}`;
  // A plan the bundle has no name for yet shows the catalog's own label, never a key.
  const name = tc.has(nameKey) ? tc(nameKey) : plan.defaultLabel;
  const buyable = !notOpen && plan.sellable;
  const oneTimeMarket = !brandPlansRenew(brand);
  return (
    <article className={`${styles.card} ${plan.isDefaultSelection ? styles.cardFeatured : ''}`} data-plan={plan.key}>
      <h3 className={styles.h3}>{name}</h3>
      {notOpen ? <span className={styles.badge}>{t('notOpen')}</span> : null}
      <p className={styles.price}>{tc(`price.${period}`, { price: formatMoney(locale, shown.amountMinor, shown.currency) })}</p>
      {shown.local ? <p className={styles.muted}>{tv('plans.localPrice')}</p> : null}
      {!shown.local && plan.currency === 'USD' && plan.amountMinor !== null ? <PriceReference amountMinor={plan.amountMinor} currency="USD" /> : null}
      {shown.monthlyEquivalentMinor !== null ? (
        <p className={styles.muted} data-monthly-equivalent="">
          {tc('monthlyEquivalent', { price: formatMoney(locale, shown.monthlyEquivalentMinor, shown.currency) })}
        </p>
      ) : null}
      {shown.savingsPercent !== null ? (
        <p className={styles.body} data-savings="">
          {tc('save', { pct: shown.savingsPercent })}
        </p>
      ) : null}
      {shown.studentDiscountPercent !== null ? (
        <p className={styles.body} data-student-discount="">
          {tv('plans.studentTag', { pct: shown.studentDiscountPercent })}
        </p>
      ) : null}
      {plan.autoRenews && plan.interval && plan.interval !== 'pass' ? (
        <p className={styles.muted}>{tc('renewsNote', { period: plan.interval })}</p>
      ) : null}
      {plan.kind === 'pass' && plan.passDays ? (
        <p className={styles.muted} data-pass-note="">
          {oneTimeMarket ? tb('pricing.passNote', { days: plan.passDays }) : tc('passNote', { days: plan.passDays })}
        </p>
      ) : null}
      {samePriceAsWeekly ? (
        <p className={styles.muted} data-same-price-as-weekly="">
          {tc('pricing.samePriceAsWeekly')}
        </p>
      ) : null}
      {/* The pack's own validity, as the API states it; no month count lives in the page. */}
      {plan.kind === 'pack' && plan.practice && plan.practice.validMonths ? (
        <p className={styles.muted}>{tc('packNote', { credits: plan.practice.credits, months: plan.practice.validMonths })}</p>
      ) : null}
      {plan.kind !== 'pack' && plan.practice ? (
        <p className={styles.muted} data-practice-allowance="">
          {oneTimeMarket && plan.practice.per === 'month'
            ? tb('pricing.practicePerMonth', { count: plan.practice.credits })
            : t('practiceCredits', { count: plan.practice.credits, per: plan.practice.per })}
        </p>
      ) : null}
      {buyable ? (
        signedIn ? (
          <Link className={styles.ctaSecondary} href={checkoutHref(plan.key)} data-plan-cta="checkout">
            {t('choosePlan')}
          </Link>
        ) : (
          <SignupLink from={`pricing:${plan.key}`} variant="secondary">
            {t('signupToBuy')}
          </SignupLink>
        )
      ) : null}
    </article>
  );
}

/** The whole numbers of a list, joined the way the locale writes a list ("7, 30 and 90"). */
function listOfNumbers(locale: string, values: readonly number[]): string {
  const parts = values.map((v) => String(v));
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(parts);
  } catch {
    return parts.join(', ');
  }
}

interface RefundRulesProps {
  policy: RefundPolicyFacts;
  /** GoApply: the entity the API names as the one collecting the payment; null → no line. */
  collectingEntity: string | null;
  /** The day counts of the passes the API lists, ascending. */
  passDays: readonly number[];
}

/**
 * The refund rules in plain words (MARKET_STRATEGY §4.4 "Printed on
 * /pricing"). Every number is an argument filled from `refundPolicy` of the
 * plans response; the strings carry none.
 */
function RefundRules({ policy, collectingEntity, passDays }: RefundRulesProps) {
  const t = useTranslations('landing.pricingPage');
  const tr = useTranslations('credits.pricing.refund');
  const tb = useTranslations('billingCn.pricing.refund');
  const locale = useLocale();
  const brand = useBrand();
  const renews = brandPlansRenew(brand);
  return (
    <div data-refund-rules="" data-refund-policy-version={policy.version || undefined}>
      <h2 className={styles.h2} id="pricing-refund-title">
        {t('refundTitle')}
      </h2>
      {renews ? (
        <>
          <ul className={styles.list}>
            <li data-refund-line="first">
              {tr('first', { days: policy.firstPurchaseDays, hours: policy.shortPlanHours, limit: policy.paidOnlyCreditLimit })}
            </li>
            <li data-refund-line="renewal">{tr('renewal', { days: policy.accidentalRenewalDays })}</li>
            <li data-refund-line="packs">{tr('packs', { months: policy.packValidMonths })}</li>
            <li data-refund-line="withdrawal">{tr('withdrawal', { days: policy.withdrawalDays })}</li>
          </ul>
          <p className={styles.spaced}>
            <a className={styles.inlineLink} href="/legal/refunds">
              {t('refundLink')}
            </a>
          </p>
        </>
      ) : (
        <>
          <ul className={styles.list} data-pass-refunds="">
            <li data-refund-line="first">
              {tb('first', { days: policy.firstPurchaseDays, hours: policy.shortPlanHours, limit: policy.paidOnlyCreditLimit })}
            </li>
            <li data-refund-line="packs">{tb('packs', { months: policy.packValidMonths })}</li>
            {passDays.length > 0 ? <li data-refund-line="oneTime">{tb('oneTime', { days: listOfNumbers(locale, passDays) })}</li> : null}
            {collectingEntity ? <li data-refund-line="entity">{tb('entity', { entity: collectingEntity })}</li> : null}
          </ul>
          <p className={styles.spaced}>
            <a className={styles.inlineLink} href="/help">
              {t('passRefundHow')}
            </a>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The published student price for a visitor who is not sent the student
 * plans (they are listed only for a verified student). Shown only when the
 * API publishes the prices (`studentOffer`); the plan name is the bundle's.
 */
function StudentOffer({ offers, currency }: { offers: readonly StudentOfferRow[]; currency: string }) {
  const tc = useTranslations('credits');
  const tv = useTranslations('accountV2');
  const locale = useLocale();
  const brand = useBrand();
  const rows = offers.filter((o) => tc.has(`plans.${brand.id}.${o.key}`));
  if (rows.length === 0) return null;
  return (
    <div className={styles.spaced} data-student-offer="">
      <h3 className={styles.h3}>{tc('pricing.studentOffer.title')}</h3>
      <ul className={styles.list}>
        {rows.map((o) => (
          <li key={o.key} data-student-offer-row={o.key}>
            {tc('pricing.studentOffer.row', { name: tc(`plans.${brand.id}.${o.key}`), price: formatMoney(locale, o.amountMinor, currency) })}
            {o.studentDiscountPercent !== null ? ` ${tv('plans.studentTag', { pct: o.studentDiscountPercent })}` : null}
          </li>
        ))}
      </ul>
      <p className={styles.muted}>{tc('pricing.studentOffer.how')}</p>
    </div>
  );
}

type CapBucket = CreditCapsResponse['buckets'][number]['bucket'];
/** Buckets whose action is an AI call (needs `ai.text`). */
const AI_BUCKETS: ReadonlySet<CapBucket> = new Set<CapBucket>(['fit_analysis', 'tailor', 'cover_letter', 'resume_check', 'rewrite', 'outreach']);

function CapsTable() {
  const t = useTranslations('landing.pricingPage');
  const tc = useTranslations('credits');
  const brand = useBrand();
  const { data } = useCreditCaps();
  const copilot = useMarketingFlag('copilot');
  const agent = useMarketingFlag('agent');
  const ai = useMarketingFlag('ai.text');
  const feed = useMarketingFlag('jobs.feed');
  // Instant alerts are emails: no row without a working mail transport.
  const alertsFlag = useMarketingFlag('jobs.alerts');
  const email = useMarketingFlag('notify.email');
  const alerts = alertsFlag && email;
  const extension = useMarketingFlag('extension') && extensionStoreId(brand.id) !== null;
  if (!data) return null;
  const shown = data.buckets.filter((b) => {
    if (b.bucket === 'assistant') return copilot;
    if (b.bucket === 'ready_kits') return agent;
    if (b.bucket === 'autofill') return extension;
    if (b.bucket === 'fit_analysis') return ai && feed;
    if (AI_BUCKETS.has(b.bucket)) return ai;
    return true;
  });
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} data-caps-table="">
        <thead>
          <tr>
            <th scope="col">{t('capsAction')}</th>
            <th scope="col">{t('capsFree')}</th>
            <th scope="col">{t('capsPro')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((b) => (
            <tr key={b.bucket}>
              <th scope="row">{tc(`buckets.${b.bucket}`)}</th>
              <td>{tc('cap.free', { cap: b.free.cap, window: b.free.window })}</td>
              <td>{tc('cap.pro', { cap: b.pro.cap, window: b.pro.window })}</td>
            </tr>
          ))}
          {feed ? (
            <tr data-cap-row="saved_searches">
              <th scope="row">{t('savedSearches')}</th>
              <td>{t('count', { count: data.entitlements.free.saved_searches })}</td>
              <td>{t('count', { count: data.entitlements.pro.saved_searches })}</td>
            </tr>
          ) : null}
          {alerts ? (
            <tr data-cap-row="instant_alerts">
              <th scope="row">{t('instantAlerts')}</th>
              <td>{t('perDay', { count: data.entitlements.free.instant_alerts })}</td>
              <td>{t('upToPerDay', { count: data.entitlements.pro.instant_alerts })}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function PricingPage() {
  const t = useTranslations('landing.pricingPage');
  const tc = useTranslations('credits');
  const locale = useLocale();
  const brand = useBrand();
  const plans = usePlans();
  const { status } = useAuth();
  const renews = brandPlansRenew(brand);
  const feed = useMarketingFlag('jobs.feed');
  const campus = useMarketingFlag('jobs.campusCalendar');
  // Only the plans API can say that nothing can be bought; unknown is not "closed".
  const notOpen = plans.data?.paymentsOpen === false;
  const all = plans.data?.plans ?? [];
  // A plan with no amount is not printed (the catalog gives every plan one).
  const paid = all.filter((p) => p.kind !== 'free' && p.amountMinor !== null);
  const monthly = monthlyPlan(all);
  const facts = plansBillingFacts(plans.data);
  const passDays = Array.from(new Set(paid.filter((p) => p.kind === 'pass' && !!p.passDays).map((p) => p.passDays as number))).sort((a, b) => a - b);
  // The student prices are published separately only while the list itself carries no student plan.
  const studentOffer = paid.some((p) => p.requiresFlag === 'student') ? [] : facts.studentOffer;
  return (
    <>
      <section className={styles.intro} aria-labelledby="pricing-title">
        <div className={styles.wrap}>
          <h1 className={styles.pageTitle} id="pricing-title">
            {t('title')}
          </h1>
          <p className={styles.lead}>{t('sub')}</p>
          {notOpen ? (
            <p className={`${styles.lead} ${styles.spaced}`} data-pricing-not-open="">
              {t('notOpenNote')}
            </p>
          ) : null}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="pricing-plans-title">
        <div className={styles.wrap}>
          <h2 className={styles.h2} id="pricing-plans-title">
            {t('plansTitle')}
          </h2>
          {plans.isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
          {plans.isError ? (
            <p className={styles.error} role="alert">
              {t('error')}
            </p>
          ) : null}
          <div className={styles.grid3}>
            <article className={styles.card} data-plan="free">
              <h3 className={styles.h3}>{tc(`plans.${brand.id}.free`)}</h3>
              <p className={styles.price}>{formatMoney(locale, 0, brand.currency)}</p>
              <p className={styles.body}>{feed ? t('freeNote') : t('freeNoteNoFeed')}</p>
              <SignupLink from="pricing:free" variant="secondary">
                {t('cta')}
              </SignupLink>
            </article>
            {paid.map((p) => (
              <PlanCard
                key={p.key}
                plan={p}
                monthly={monthly}
                samePriceAsWeekly={samePriceAsWeeklyBilling(p, all)}
                notOpen={notOpen}
                signedIn={status === 'authenticated'}
              />
            ))}
          </div>
          {studentOffer.length > 0 ? <StudentOffer offers={studentOffer} currency={plans.data?.currency ?? brand.currency} /> : null}
        </div>
      </section>

      <section className={styles.sectionAlt} aria-labelledby="pricing-caps-title">
        <div className={styles.wrap}>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2} id="pricing-caps-title">
              {t('capsTitle')}
            </h2>
            <p className={styles.body}>{t('capsSub')}</p>
          </div>
          <CapsTable />
          <div className={styles.spaced}>
            <h3 className={styles.h3}>{t('freeAlways')}</h3>
            <p className={styles.body}>{feed ? t('freeAlwaysBody') : t('freeAlwaysBodyNoFeed')}</p>
            {campus ? <p className={styles.body}>{t('freeAlwaysCampus')}</p> : null}
          </div>
        </div>
      </section>

      {/* The refund lines wait for the plans response: their numbers come from it, and without it nothing is printed. */}
      <section className={styles.section} aria-labelledby={facts.refundPolicy ? 'pricing-refund-title' : 'pricing-renew-title'}>
        <div className={`${styles.wrap} ${styles.grid2}`}>
          {facts.refundPolicy ? <RefundRules policy={facts.refundPolicy} collectingEntity={facts.collectingEntity} passDays={passDays} /> : null}
          <div>
            <h2 className={styles.h2} id="pricing-renew-title">
              {t('renewTitle')}
            </h2>
            {renews ? (
              <>
                <ul className={styles.list}>
                  <li>{t('renew1')}</li>
                  <li>{t('renew2')}</li>
                </ul>
                <p className={styles.spaced}>
                  <CancelFooterLink className={styles.inlineLink} />
                </p>
              </>
            ) : (
              <p className={styles.body}>{t('cnPasses')}</p>
            )}
          </div>
        </div>
      </section>

      <Faq id="pricing-faq" title={t('faqTitle')} items={PRICING_FAQ_KEYS.map((k) => ({ q: t(`${k}.q`), a: t(`${k}.a`) }))} />
    </>
  );
}
