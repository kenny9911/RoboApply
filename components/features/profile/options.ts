// components/features/profile/options.ts — option lists the profile forms use.
//
// Mirrors of runtime constants in the server contracts (the browser never
// imports server code; lib/api/contracts is type-only). Parity with the
// server lists is asserted in __tests__/components/profile/profile.test.tsx.

import type { ProfileView } from '../../../lib/api/contracts/profile';

/** server/src/features/tw/profileFields.ts TW_COUNTIES */
export const TW_COUNTIES = [
  'TPE', 'NWT', 'KEE', 'TAO', 'HSZ', 'HSQ', 'MIA', 'TXG', 'CHA', 'NAN', 'YUN',
  'CYI', 'CYQ', 'TNN', 'KHH', 'PIF', 'ILA', 'HUA', 'TTT', 'PEN', 'KIN', 'LIE',
] as const;
export const TW_ANYWHERE = 'ANY';
/** server/src/features/tw/profileFields.ts TW_WORK_PERMIT_STATUSES */
export const TW_WORK_PERMIT_STATUSES = ['citizen_or_resident', 'work_permit_needed', 'gold_card'] as const;

/** server/src/features/profile/contract.ts EEO_OPTIONS */
export const EEO_OPTIONS = {
  gender: ['female', 'male', 'non_binary', 'decline'],
  raceEthnicity: ['hispanic_latino', 'white', 'black', 'asian', 'native_american', 'pacific_islander', 'two_or_more', 'decline'],
  veteranStatus: ['protected_veteran', 'not_veteran', 'decline'],
  disabilityStatus: ['yes', 'no', 'decline'],
} as const;
export type EeoQuestion = keyof typeof EEO_OPTIONS;

/** server/src/features/onboarding-cn/contract.ts */
export const CN_IDENTITIES = ['yingjie', 'zaixiao', 'shezhao'] as const;
export const CN_DEGREE_OPTIONS = ['dazhuan', 'bachelor', 'master', 'phd', 'other'] as const;
export const CN_JOB_SEARCH_STATUS = ['left_available', 'employed_within_month', 'employed_open', 'employed_not_looking'] as const;
export const CN_CLASS_YEAR_RANGE = { min: 2025, max: 2030 } as const;

export const LANGUAGE_LEVELS = ['basic', 'conversational', 'professional', 'fluent', 'native'] as const;
export const PHONE_TYPES = ['mobile', 'home', 'work', 'other'] as const;

/** ISO 3166-1 alpha-2 codes; names come from Intl.DisplayNames in the viewer's language. */
export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BN', 'BO',
  'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG', 'CH', 'CI', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CY', 'CZ', 'DE',
  'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FM', 'FR', 'GA', 'GB', 'GD', 'GE', 'GH', 'GM', 'GN',
  'GQ', 'GR', 'GT', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IN', 'IQ', 'IR', 'IS', 'IT', 'JM', 'JO', 'JP', 'KE',
  'KG', 'KH', 'KI', 'KM', 'KN', 'KR', 'KW', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD',
  'ME', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MR', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NE', 'NG', 'NI', 'NL', 'NO',
  'NP', 'NR', 'NZ', 'OM', 'PA', 'PE', 'PG', 'PH', 'PK', 'PL', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB',
  'SC', 'SD', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SY', 'SZ', 'TD', 'TG', 'TH', 'TJ', 'TL', 'TM',
  'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VN', 'VU', 'WS', 'XK', 'YE', 'ZA', 'ZM',
  'ZW',
] as const;

const displayNames = new Map<string, Intl.DisplayNames | null>();

/** The country's name in `locale`, falling back to the code. */
export function countryName(code: string, locale: string): string {
  if (!displayNames.has(locale)) {
    try {
      displayNames.set(locale, new Intl.DisplayNames([locale, 'en'], { type: 'region' }));
    } catch {
      displayNames.set(locale, null);
    }
  }
  return displayNames.get(locale)?.of(code) ?? code;
}

/** Countries sorted by their name in `locale`. */
export function sortedCountries(locale: string): Array<{ code: string; name: string }> {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale));
}

/** Mirror of server/src/features/tw/profileFields.ts isTaiwanRelevant. */
export function isTaiwanRelevant(profile: Pick<ProfileView, 'country' | 'workAuth' | 'twFields' | 'availability'>, locale: string): boolean {
  if (profile.availability.market !== 'intl') return false;
  const tw = profile.twFields;
  const hasAnswers = !!tw && Boolean(tw.desiredTitles?.length || tw.desiredCategoryIds?.length || tw.desiredLocations?.length || tw.desiredPay);
  if (hasAnswers) return true;
  if (profile.country === 'TW') return true;
  if (profile.workAuth.some((w) => w.country === 'TW')) return true;
  return locale === 'zh-TW';
}

/** EEO answers are for people who'd like to work in the US (F-ACCT-04). */
export function targetsUs(profile: Pick<ProfileView, 'country' | 'workAuth'>): boolean {
  return profile.country === 'US' || profile.workAuth.some((w) => w.country === 'US');
}

/** True for a public LinkedIn profile link (mirror of the contract's isLinkedInProfileUrl). */
export function isLinkedInProfileUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return false;
  return /^\/(in|pub)\/[^/]+\/?/.test(url.pathname);
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

export const E164 = /^\+[1-9]\d{6,14}$/;
/** '+1 (415) 555-0100' → '+14155550100'. */
export function compactPhone(value: string): string {
  return value.replace(/[\s().-]/g, '');
}

/** 'YYYY', 'YYYY-MM' (or empty). */
export const YM = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
