'use client';

// PriceReference — the Taiwan reference line under a USD price
// (TASK_PLAN.md R-25, WP-21b; CN_TW_LAUNCH_PLAN.md L-7, WP-PAY "TWD reference"):
//   en     "About NT$800 (estimated at the Bank of Taiwan rate of 2026-10-01; your card issuer sets the final amount)"
//   zh-TW  "約 NT$800（依 {source} {asOf} 匯率估算，實際金額以發卡銀行為準）"
//
// Billing stays in USD; this is a reference only. It renders only for the
// zh-TW locale or a Taiwan visitor, only when the admin-entered rate
// (`fx.reference`: rate + source + as-of) is 45 days old or less, and nothing
// otherwise — never a guessed or stale rate (D3). The rate arrives with
// `GET /billing/plans` (lib/api/credits `plansExtras`). The visitor's country
// comes from `PriceReferenceCountry` when a caller resolved it (the plan sheet
// wraps its options with the edge-header country), else from that same
// response. The props stay the FND-6b slot contract.

import { createContext, useContext, type ReactNode } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { plansExtras, usePlans } from '../../../hooks/credits/usePlans';
import { isFxReferenceFresh, twdReferenceAmount } from '../../../lib/pricing';
import { useBrand } from '../../../lib/brand/BrandProvider';

export interface PriceReferenceProps {
  /** The price in minor units of `currency` (cents). */
  amountMinor: number;
  currency: 'USD';
}

const CountryContext = createContext<string | null>(null);

/**
 * The visitor's ISO country for every PriceReference below, when the caller
 * already resolved it (edge header). It takes precedence over
 * `visitor.country` in the plans response, which is used when this is null.
 */
export function PriceReferenceCountry({ country, children }: { country: string | null; children: ReactNode }) {
  return <CountryContext.Provider value={country}>{children}</CountryContext.Provider>;
}

export function PriceReference({ amountMinor, currency }: PriceReferenceProps) {
  const visitorCountry = useContext(CountryContext);
  const t = useTranslations('credits');
  const locale = useLocale();
  const format = useFormatter();
  const brand = useBrand();
  const { data } = usePlans({ enabled: brand.market === 'intl' });
  if (brand.market !== 'intl' || currency !== 'USD') return null;

  const extras = plansExtras(data);
  const fxReference = extras.fxReference;
  const country = (visitorCountry ? visitorCountry.toUpperCase() : null) ?? extras.visitorCountry;
  const forTaiwan = locale === 'zh-TW' || country === 'TW';
  if (!forTaiwan || !isFxReferenceFresh(fxReference)) return null;
  const twd = twdReferenceAmount(amountMinor, fxReference.ratePerUsd);
  if (twd === null) return null;

  const amount = format.number(twd, { style: 'currency', currency: 'TWD', currencyDisplay: 'symbol', maximumFractionDigits: 0, minimumFractionDigits: 0 });
  return (
    <span data-testid="price-reference" data-as-of={fxReference.asOf} style={{ display: 'block', fontSize: 'var(--fs-label)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
      {t('priceReference', { amount, source: fxReference.source, asOf: fxReference.asOf })}
    </span>
  );
}

export default PriceReference;
