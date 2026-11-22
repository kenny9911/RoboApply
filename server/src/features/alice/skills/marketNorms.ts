// server/src/features/alice/skills/marketNorms.ts — how a market talks about jobs and pay.
//
// The Intake interviewer asks for pay in the period and currency people in the
// market quote it in, and the Profile writer writes titles the way postings
// there do. GoApply (market `cn`) never asks about visas and quotes pay per
// month with the number of months a year. Unknown countries fall back to the
// brand's currency and a yearly figure.

import type { AlicePay } from '../contract.js';

export type AliceMarket = 'intl' | 'cn';

export interface MarketNorms {
  market: AliceMarket;
  /** ISO country the norms are for, when known. */
  country: string | null;
  currency: string;
  payPeriod: AlicePay['period'];
  /** Whether Alice may ask about visa sponsorship. */
  askSponsorship: boolean;
  /** For the model: how pay and titles are written here. */
  directive: string;
}

interface CountryNorm {
  currency: string;
  period: AlicePay['period'];
  titles: string;
}

/** Countries whose usual way of quoting pay differs from a yearly USD figure. */
const COUNTRY_NORMS: Readonly<Record<string, CountryNorm>> = {
  US: { currency: 'USD', period: 'year', titles: 'US English titles (Software Engineer II, Senior Product Manager).' },
  CA: { currency: 'CAD', period: 'year', titles: 'North American English titles.' },
  GB: { currency: 'GBP', period: 'year', titles: 'British English titles.' },
  IE: { currency: 'EUR', period: 'year', titles: 'British English titles.' },
  DE: { currency: 'EUR', period: 'year', titles: 'German or English titles as German postings use them (often English in tech).' },
  AT: { currency: 'EUR', period: 'year', titles: 'German or English titles.' },
  CH: { currency: 'CHF', period: 'year', titles: 'German, French or English titles.' },
  FR: { currency: 'EUR', period: 'year', titles: 'French titles, English ones in tech.' },
  ES: { currency: 'EUR', period: 'year', titles: 'Spanish titles, English ones in tech.' },
  PT: { currency: 'EUR', period: 'year', titles: 'Portuguese titles, English ones in tech.' },
  NL: { currency: 'EUR', period: 'year', titles: 'English or Dutch titles.' },
  IT: { currency: 'EUR', period: 'year', titles: 'Italian titles, English ones in tech.' },
  BR: { currency: 'BRL', period: 'month', titles: 'Portuguese titles (Brazil) with levels such as Júnior, Pleno, Sênior.' },
  MX: { currency: 'MXN', period: 'month', titles: 'Spanish titles.' },
  AU: { currency: 'AUD', period: 'year', titles: 'Australian English titles.' },
  NZ: { currency: 'NZD', period: 'year', titles: 'English titles.' },
  IN: { currency: 'INR', period: 'year', titles: 'Indian English titles; pay is often discussed as a yearly package (LPA).' },
  SG: { currency: 'SGD', period: 'month', titles: 'English titles.' },
  HK: { currency: 'HKD', period: 'month', titles: 'English or Traditional Chinese titles.' },
  JP: { currency: 'JPY', period: 'year', titles: 'Japanese titles as Japanese postings write them, English ones at international companies.' },
  KR: { currency: 'KRW', period: 'year', titles: 'Korean titles, English ones at international companies.' },
  TW: { currency: 'TWD', period: 'month', titles: 'Traditional Chinese titles as Taiwanese postings write them, often with the English one.' },
  CN: { currency: 'CNY', period: 'month', titles: 'Simplified Chinese titles as mainland postings write them.' },
};

export function marketNorms(market: AliceMarket, country: string | null): MarketNorms {
  if (market === 'cn') {
    return {
      market,
      country: 'CN',
      currency: 'CNY',
      payPeriod: 'month',
      askSponsorship: false,
      directive:
        'Mainland China (GoApply). Ask pay per month in CNY (元/月 or K/月) and, when they say it, how many months a year (13薪, 15薪); record the monthly figure. Write titles as mainland postings do. Never ask about visas, hukou or household registration.',
    };
  }
  const norm = country ? COUNTRY_NORMS[country] : undefined;
  const currency = norm?.currency ?? 'USD';
  const period = norm?.period ?? 'year';
  return {
    market,
    country,
    currency,
    payPeriod: period,
    askSponsorship: true,
    directive: `${country ? `Job market: ${country}.` : 'Job market: not known; follow the places they name.'} Ask pay ${period === 'year' ? 'as a yearly gross amount' : 'as a monthly gross amount'} in ${currency} unless they name another currency or place. ${norm?.titles ?? 'Write titles as postings in the places they name do.'}`,
  };
}
