// ISO 3166-1 alpha-2 regions. Names come from the user's Intl locale.
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');

export function countryOptions(locale: string): { code: string; name: string }[] {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  const collator = new Intl.Collator(locale);
  return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * What the developer guide shows for a brand: the country a search runs in
 * when the request names none, and the two request examples. The capability
 * is the same on both brands; the market is what differs (D5), so GoApply's
 * examples are mainland ones and never name a source it does not have.
 */
export interface JobSearchBrandExamples {
  /** ISO 3166-1 alpha-2, upper case: the brand's default search country. */
  defaultCountry: string;
  envPrefix: string;
  search: Record<string, unknown>;
  agent: Record<string, unknown>;
}

export function jobSearchBrandExamples(brand: { id: string; market: string; defaultCountry: string }): JobSearchBrandExamples {
  const envPrefix = brand.id.toUpperCase();
  if (brand.market === 'cn') {
    return {
      defaultCountry: brand.defaultCountry,
      envPrefix,
      search: { query: '数据分析师', country: brand.defaultCountry, location: '上海', datePosted: 'week', limit: 20 },
      agent: { request: '找上海的数据分析师职位，最近一周发布。', limit: 20 },
    };
  }
  return {
    defaultCountry: brand.defaultCountry,
    envPrefix,
    search: { query: 'software engineer', country: 'US', remote: true, datePosted: 'week', limit: 20 },
    agent: { request: 'Find remote backend engineering jobs in Taiwan posted this week.', linkedinOnly: true, limit: 20 },
  };
}

/** Country options with the brand's default country first. */
export function countryOptionsFor(locale: string, brand: { defaultCountry: string }): { code: string; name: string }[] {
  const all = countryOptions(locale);
  const first = all.find((option) => option.code === brand.defaultCountry);
  return first ? [first, ...all.filter((option) => option !== first)] : all;
}
