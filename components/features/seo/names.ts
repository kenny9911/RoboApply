// components/features/seo/names.ts — pure, server- and client-safe naming
// for the public SEO views: role and city names in the UI language (the API
// sends the taxonomy's English + Chinese labels and the city table's names),
// country names, and the browse page title key + params.

import type { SeoCityRef, SeoPageResponse, SeoRoleRef } from '../../../lib/api/contracts/seo';

/** Simplified-script Chinese UI (zh, zh-CN, zh-Hans, zh-SG); zh-TW / zh-HK / zh-Hant are Traditional. */
function isSimplifiedChinese(locale: string): boolean {
  return /^zh(?:-(?:CN|SG|Hans(?:-[A-Za-z]+)?))?$/i.test(locale);
}

/**
 * The role name in the UI language. The taxonomy carries English and
 * Simplified Chinese labels only, so Traditional-Chinese UIs (zh-TW) show the
 * English label rather than mix Simplified role names with Traditional city
 * names (until the taxonomy has a Traditional label — request to its owner).
 */
export function roleLabel(role: SeoRoleRef | null | undefined, locale: string): string {
  if (!role) return '';
  return isSimplifiedChinese(locale) && role.labelZh ? role.labelZh : role.label;
}

export function cityLabel(city: SeoCityRef | null | undefined, locale: string): string {
  if (!city) return '';
  if (locale === 'zh-TW') return city.zhHant ?? city.zh ?? city.name;
  if (locale.startsWith('zh')) return city.zh ?? city.name;
  return city.name;
}

/** Country name in the UI language (falls back to the code). */
export function countryLabel(code: string | null | undefined, locale: string): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** `seo.browse.title.<key>` and its params for a browse page. */
export function browseTitle(data: Pick<SeoPageResponse, 'type' | 'segment' | 'role' | 'city' | 'sponsorCountry'>, locale: string): { key: string; params: Record<string, string> } {
  const key = data.type === 'segment' ? (data.segment === 'internships' ? 'segment_internships' : 'segment_entry') : data.type;
  return {
    key,
    params: { role: roleLabel(data.role, locale), city: cityLabel(data.city, locale), country: countryLabel(data.sponsorCountry, locale) },
  };
}
