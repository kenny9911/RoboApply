'use client';

// /pricing (both brands) — F-BILL-02, PRODUCT §6.1–§6.5.
//
// Every price comes from GET /billing/plans (the plan catalog config), every
// cap from GET /support/credit-caps (the credit catalog), never from copy.
// "Save N%" is the server's own computation against our monthly price. A plan
// without a configured price shows "Price not set yet". GoApply shows the fee
// schedule with "Not open yet" until CN payments open (R-15). Pro caps are
// printed ("Up to N a day"), never "unlimited". No competitor prices.
//
// Nothing here lists a feature the visitor can't use (R-04, D3): job-list
// rows and copy need `jobs.feed` (off on GoApply while
// CN_RECRUITMENT_INFO_MODE is off, R-14), alert rows `jobs.alerts`, AI rows
// `ai.text` (R-13), and the campus calendar line `jobs.campusCalendar`.

import { useLocale, useTranslations } from 'next-intl';

import { usePlans } from '../../../hooks/credits/usePlans';
import type { CatalogPlan } from '../../../lib/api/credits';
import type { CreditCapsResponse } from '../../../lib/api/contracts/support';
import { useBrand } from '../../../lib/brand';
import { formatMoney } from '../../../lib/pricing';
import { CancelFooterLink } from '../credits';
import { PriceReference } from '../market';
import { PRICING_FAQ_KEYS, extensionStoreId } from './catalog';
import { useCreditCaps, useMarketingFlag } from './hooks';
import { Faq } from './Sections';
import { SignupLink } from './SignupLink';
import styles from './marketing.module.css';


type Period = 'week' | 'month' | 'quarter' | 'once';
function periodOf(plan: CatalogPlan): Period {
  if (plan.kind !== 'subscription') return 'once';
  return plan.interval === 'week' ? 'week' : plan.interval === 'quarter' ? 'quarter' : 'month';
}

function PlanCard({ plan, open }: { plan: CatalogPlan & { savingsPercent?: number | null; monthlyEquivalentMinor?: number | null }; open: boolean }) {
  const t = useTranslations('landing.pricingPage');
  const tc = useTranslations('credits');
  const locale = useLocale();
  const brand = useBrand();
  const period = periodOf(plan);
  const price = plan.amountMinor !== null ? tc(`price.${period}`, { price: formatMoney(locale, plan.amountMinor, plan.currency) }) : null;
  return (
    <article className={`${styles.card} ${plan.isDefaultSelection ? styles.cardFeatured : ''}`} data-plan={plan.key}>
      <h3 className={styles.h3}>{tc(`plans.${brand.id}.${plan.key}`)}</h3>
      {!open ? <span className={styles.badge}>{t('notOpen')}</span> : null}
      <p className={styles.price}>{price ?? t('notSet')}</p>
      {plan.amountMinor !== null && plan.currency === 'USD' ? <PriceReference amountMinor={plan.amountMinor} currency="USD" /> : null}
      {plan.monthlyEquivalentMinor ? (
        <p className={styles.muted}>{tc('monthlyEquivalent', { price: formatMoney(locale, plan.monthlyEquivalentMinor, plan.currency) })}</p>
      ) : null}
      {plan.savingsPercent ? <p className={styles.body}>{tc('save', { pct: plan.savingsPercent })}</p> : null}
      {plan.autoRenews && plan.interval && plan.interval !== 'pass' ? (
        <p className={styles.muted}>{tc('renewsNote', { period: plan.interval })}</p>
      ) : null}
      {plan.kind === 'pass' && plan.passDays ? <p className={styles.muted}>{tc('passNote', { days: plan.passDays })}</p> : null}
      {plan.kind === 'pack' && plan.practice ? (
        <p className={styles.muted}>{tc('packNote', { credits: plan.practice.credits, months: plan.practice.validMonths ?? 12 })}</p>
      ) : null}
      {plan.kind !== 'pack' && plan.practice ? (
        <p className={styles.muted}>{t('practiceCredits', { count: plan.practice.credits, per: plan.practice.per })}</p>
      ) : null}
    </article>
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
  const alerts = useMarketingFlag('jobs.alerts');
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
  const cn = brand.market === 'cn';
  const feed = useMarketingFlag('jobs.feed');
  const campus = useMarketingFlag('jobs.campusCalendar');
  const open = plans.data?.paymentsOpen ?? !cn;
  const paid = (plans.data?.plans ?? []).filter((p) => p.kind !== 'free');
  return (
    <>
      <section className={styles.intro} aria-labelledby="pricing-title">
        <div className={styles.wrap}>
          <h1 className={styles.pageTitle} id="pricing-title">
            {t('title')}
          </h1>
          <p className={styles.lead}>{t('sub')}</p>
          {!open ? <p className={`${styles.lead} ${styles.spaced}`}>{t('notOpenNote')}</p> : null}
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
              <PlanCard key={p.key} plan={p} open={open} />
            ))}
          </div>
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

      <section className={styles.section} aria-labelledby="pricing-refund-title">
        <div className={`${styles.wrap} ${styles.grid2}`}>
          <div>
            <h2 className={styles.h2} id="pricing-refund-title">
              {t('refundTitle')}
            </h2>
            {cn ? (
              <p className={styles.body}>{t('cnRefund')}</p>
            ) : (
              <>
                <ul className={styles.list}>
                  <li>{t('refund1')}</li>
                  <li>{t('refund2')}</li>
                  <li>{t('refund3')}</li>
                  <li>{t('refund4')}</li>
                </ul>
                <p className={styles.spaced}>
                  <a className={styles.inlineLink} href="/legal/refunds">
                    {t('refundLink')}
                  </a>
                </p>
              </>
            )}
          </div>
          <div>
            <h2 className={styles.h2}>{t('renewTitle')}</h2>
            {cn ? (
              <p className={styles.body}>{t('cnPasses')}</p>
            ) : (
              <>
                <ul className={styles.list}>
                  <li>{t('renew1')}</li>
                  <li>{t('renew2')}</li>
                </ul>
                <p className={styles.spaced}>
                  <CancelFooterLink className={styles.inlineLink} />
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <Faq id="pricing-faq" title={t('faqTitle')} items={PRICING_FAQ_KEYS.map((k) => ({ q: t(`${k}.q`), a: t(`${k}.a`) }))} />
    </>
  );
}
