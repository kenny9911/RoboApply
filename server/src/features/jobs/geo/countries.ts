// server/src/features/jobs/geo/countries.ts
//
// Country and first-level subdivision reference tables for location parsing
// (WP-16a, ARCH §4.4 "Location"). Pure data: ISO 3166-1 alpha-2 codes,
// English / Simplified / Traditional Chinese names and the spellings job
// postings commonly use. Subdivisions carry the code postings write ("TX",
// "ON", "NSW") or, where postings write names (China, Taiwan, UK), the name.
//
// Sources (public facts, D3): ISO 3166-1 / ISO 3166-2 code lists and USPS
// state abbreviations. No population or ranking data lives here.

export interface CountryRecord {
  /** ISO 3166-1 alpha-2, upper case. */
  code: string;
  name: string;
  zh: string;
  zhHant: string;
  /** Extra spellings matched case-insensitively (ISO alpha-3 included). */
  aliases: readonly string[];
}

/** Matched only as a whole token, case-sensitive, because they are also English words or US state codes. */
const C = (code: string, name: string, zh: string, zhHant: string, aliases: string[] = []): CountryRecord => ({
  code,
  name,
  zh,
  zhHant,
  aliases,
});

export const COUNTRIES: readonly CountryRecord[] = [
  C('US', 'United States', '美国', '美國', ['USA', 'U.S.', 'U.S.A.', 'United States of America', 'America']),
  C('CA', 'Canada', '加拿大', '加拿大', ['CAN']),
  C('GB', 'United Kingdom', '英国', '英國', ['UK', 'U.K.', 'GBR', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland']),
  C('IE', 'Ireland', '爱尔兰', '愛爾蘭', ['IRL']),
  C('DE', 'Germany', '德国', '德國', ['DEU', 'Deutschland']),
  C('FR', 'France', '法国', '法國', ['FRA']),
  C('NL', 'Netherlands', '荷兰', '荷蘭', ['NLD', 'The Netherlands', 'Holland']),
  C('ES', 'Spain', '西班牙', '西班牙', ['ESP', 'España']),
  C('PT', 'Portugal', '葡萄牙', '葡萄牙', ['PRT']),
  C('IT', 'Italy', '意大利', '義大利', ['ITA', 'Italia']),
  C('CH', 'Switzerland', '瑞士', '瑞士', ['CHE', 'Schweiz', 'Suisse']),
  C('AT', 'Austria', '奥地利', '奧地利', ['AUT', 'Österreich']),
  C('BE', 'Belgium', '比利时', '比利時', ['BEL', 'Belgique', 'België']),
  C('SE', 'Sweden', '瑞典', '瑞典', ['SWE', 'Sverige']),
  C('NO', 'Norway', '挪威', '挪威', ['NOR', 'Norge']),
  C('DK', 'Denmark', '丹麦', '丹麥', ['DNK', 'Danmark']),
  C('FI', 'Finland', '芬兰', '芬蘭', ['FIN', 'Suomi']),
  C('PL', 'Poland', '波兰', '波蘭', ['POL', 'Polska']),
  C('CZ', 'Czechia', '捷克', '捷克', ['CZE', 'Czech Republic']),
  C('IL', 'Israel', '以色列', '以色列', ['ISR']),
  C('AE', 'United Arab Emirates', '阿联酋', '阿聯酋', ['ARE', 'UAE', 'U.A.E.']),
  C('IN', 'India', '印度', '印度', ['IND']),
  C('SG', 'Singapore', '新加坡', '新加坡', ['SGP']),
  C('HK', 'Hong Kong', '中国香港', '香港', ['HKG', 'Hong Kong SAR', '香港特别行政区', '香港特別行政區']),
  C('MO', 'Macao', '中国澳门', '澳門', ['MAC', 'Macau', 'Macao SAR']),
  C('TW', 'Taiwan', '中国台湾', '台灣', ['TWN', '臺灣', '台湾', 'Republic of China', 'R.O.C.', 'Taiwan, Province of China']),
  C('CN', 'China', '中国', '中國', ['CHN', "People's Republic of China", 'PRC', 'Mainland China', 'China Mainland', '中国大陆', '中國大陸', '中华人民共和国', '中華人民共和國']),
  C('JP', 'Japan', '日本', '日本', ['JPN']),
  C('KR', 'South Korea', '韩国', '韓國', ['KOR', 'Korea', 'Republic of Korea', '南韩', '南韓']),
  C('AU', 'Australia', '澳大利亚', '澳洲', ['AUS', '澳洲']),
  C('NZ', 'New Zealand', '新西兰', '紐西蘭', ['NZL']),
  C('MY', 'Malaysia', '马来西亚', '馬來西亞', ['MYS']),
  C('TH', 'Thailand', '泰国', '泰國', ['THA']),
  C('VN', 'Vietnam', '越南', '越南', ['VNM', 'Viet Nam']),
  C('PH', 'Philippines', '菲律宾', '菲律賓', ['PHL']),
  C('ID', 'Indonesia', '印度尼西亚', '印尼', ['IDN']),
  C('BR', 'Brazil', '巴西', '巴西', ['BRA', 'Brasil']),
  C('MX', 'Mexico', '墨西哥', '墨西哥', ['MEX', 'México']),
  C('AR', 'Argentina', '阿根廷', '阿根廷', ['ARG']),
  C('CL', 'Chile', '智利', '智利', ['CHL']),
  C('CO', 'Colombia', '哥伦比亚', '哥倫比亞', ['COL']),
  C('ZA', 'South Africa', '南非', '南非', ['ZAF']),
  C('NG', 'Nigeria', '尼日利亚', '奈及利亞', ['NGA']),
  C('KE', 'Kenya', '肯尼亚', '肯亞', ['KEN']),
  C('EG', 'Egypt', '埃及', '埃及', ['EGY']),
  C('TR', 'Türkiye', '土耳其', '土耳其', ['TUR', 'Turkey']),
  C('SA', 'Saudi Arabia', '沙特阿拉伯', '沙烏地阿拉伯', ['SAU', 'KSA']),
  C('QA', 'Qatar', '卡塔尔', '卡達', ['QAT']),
  C('RO', 'Romania', '罗马尼亚', '羅馬尼亞', ['ROU']),
  C('HU', 'Hungary', '匈牙利', '匈牙利', ['HUN']),
  C('GR', 'Greece', '希腊', '希臘', ['GRC']),
  C('UA', 'Ukraine', '乌克兰', '烏克蘭', ['UKR']),
  C('EE', 'Estonia', '爱沙尼亚', '愛沙尼亞', ['EST']),
  C('LU', 'Luxembourg', '卢森堡', '盧森堡', ['LUX']),
  C('PK', 'Pakistan', '巴基斯坦', '巴基斯坦', ['PAK']),
  C('BD', 'Bangladesh', '孟加拉国', '孟加拉', ['BGD']),
  C('LK', 'Sri Lanka', '斯里兰卡', '斯里蘭卡', ['LKA']),
  C('PE', 'Peru', '秘鲁', '秘魯', ['PER']),
  C('CR', 'Costa Rica', '哥斯达黎加', '哥斯大黎加', ['CRI']),
];

export interface SubdivisionRecord {
  /** ISO 3166-1 alpha-2 of the country. */
  country: string;
  /** What `locationRegion` stores: the postal code where postings use one (US, CA, AU, IN), else the English name. */
  code: string;
  name: string;
  zh?: string;
  zhHant?: string;
  aliases?: readonly string[];
}

const S = (country: string, code: string, name: string, extra: Partial<Pick<SubdivisionRecord, 'zh' | 'zhHant' | 'aliases'>> = {}): SubdivisionRecord => ({
  country,
  code,
  name,
  ...extra,
});

const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['PR', 'Puerto Rico'],
];

const CA_PROVINCES: [string, string][] = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'],
  ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'], ['YT', 'Yukon'],
];

const AU_STATES: [string, string][] = [
  ['NSW', 'New South Wales'], ['VIC', 'Victoria'], ['QLD', 'Queensland'], ['WA', 'Western Australia'],
  ['SA', 'South Australia'], ['TAS', 'Tasmania'], ['ACT', 'Australian Capital Territory'], ['NT', 'Northern Territory'],
];

const IN_STATES: [string, string][] = [
  ['KA', 'Karnataka'], ['MH', 'Maharashtra'], ['DL', 'Delhi'], ['TG', 'Telangana'], ['TN', 'Tamil Nadu'],
  ['HR', 'Haryana'], ['UP', 'Uttar Pradesh'], ['WB', 'West Bengal'], ['GJ', 'Gujarat'], ['KL', 'Kerala'],
];

/** Mainland China provinces and municipalities (names; postings write 广东省 / Guangdong). */
const CN_PROVINCES: [string, string, string][] = [
  ['Beijing', '北京', '北京'], ['Shanghai', '上海', '上海'], ['Tianjin', '天津', '天津'], ['Chongqing', '重庆', '重慶'],
  ['Guangdong', '广东', '廣東'], ['Zhejiang', '浙江', '浙江'], ['Jiangsu', '江苏', '江蘇'], ['Sichuan', '四川', '四川'],
  ['Hubei', '湖北', '湖北'], ['Hunan', '湖南', '湖南'], ['Shaanxi', '陕西', '陝西'], ['Fujian', '福建', '福建'],
  ['Shandong', '山东', '山東'], ['Henan', '河南', '河南'], ['Hebei', '河北', '河北'], ['Shanxi', '山西', '山西'],
  ['Anhui', '安徽', '安徽'], ['Jiangxi', '江西', '江西'], ['Liaoning', '辽宁', '遼寧'], ['Jilin', '吉林', '吉林'],
  ['Heilongjiang', '黑龙江', '黑龍江'], ['Yunnan', '云南', '雲南'], ['Guizhou', '贵州', '貴州'], ['Guangxi', '广西', '廣西'],
  ['Hainan', '海南', '海南'], ['Gansu', '甘肃', '甘肅'], ['Qinghai', '青海', '青海'], ['Ningxia', '宁夏', '寧夏'],
  ['Xinjiang', '新疆', '新疆'], ['Inner Mongolia', '内蒙古', '內蒙古'], ['Tibet', '西藏', '西藏'],
];

const GB_NATIONS: [string, string, string][] = [
  ['England', '英格兰', '英格蘭'],
  ['Scotland', '苏格兰', '蘇格蘭'],
  ['Wales', '威尔士', '威爾斯'],
  ['Northern Ireland', '北爱尔兰', '北愛爾蘭'],
];

export const SUBDIVISIONS: readonly SubdivisionRecord[] = [
  ...US_STATES.map(([code, name]) => S('US', code, name)),
  ...CA_PROVINCES.map(([code, name]) => S('CA', code, name)),
  ...AU_STATES.map(([code, name]) => S('AU', code, name)),
  ...IN_STATES.map(([code, name]) => S('IN', code, name)),
  ...CN_PROVINCES.map(([name, zh, zhHant]) =>
    S('CN', name, name, { zh, zhHant, aliases: [`${zh}省`, `${zhHant}省`, `${zh}市`, `${zh}自治区`, `${name} Province`] }),
  ),
  ...GB_NATIONS.map(([name, zh, zhHant]) => S('GB', name, name, { zh, zhHant })),
];

// ── Lookups ─────────────────────────────────────────────────────────────────

/** Lower-case, width-folded, dots and extra spaces removed. */
export function geoKey(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

/** Names and aliases that are not two-letter Latin codes (safe to match case-insensitively). */
const COUNTRY_BY_NAME = new Map<string, CountryRecord>();
for (const c of COUNTRIES) {
  for (const n of [c.name, c.zh, c.zhHant, ...c.aliases]) {
    const key = geoKey(n);
    if ((key.length > 2 || /[\u3400-\u9fff]/.test(key)) && !COUNTRY_BY_NAME.has(key)) COUNTRY_BY_NAME.set(key, c);
  }
}

export function countryByCode(code: string | null | undefined): CountryRecord | null {
  if (!code) return null;
  return COUNTRY_BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

/** A country by full name / alias (not a bare two-letter code). */
export function countryByName(name: string | null | undefined): CountryRecord | null {
  if (!name) return null;
  return COUNTRY_BY_NAME.get(geoKey(name)) ?? null;
}

/** A country from either form: an ISO alpha-2 code (any case) or a name. */
export function resolveCountry(value: string | null | undefined): CountryRecord | null {
  if (!value) return null;
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return countryByCode(v) ?? (v.toUpperCase() === 'UK' ? countryByCode('GB') : null);
  return countryByName(v);
}

/** Country names (CJK spellings included), longest first, for substring scans of unseparated CJK text. */
export const CJK_COUNTRY_NAMES: readonly { text: string; country: CountryRecord }[] = COUNTRIES.flatMap((c) =>
  [c.zh, c.zhHant, ...c.aliases]
    .filter((n) => /[㐀-鿿]/.test(n))
    .map((text) => ({ text, country: c })),
).sort((a, b) => b.text.length - a.text.length);

const SUB_BY_COUNTRY = new Map<string, Map<string, SubdivisionRecord>>();
for (const s of SUBDIVISIONS) {
  const map = SUB_BY_COUNTRY.get(s.country) ?? new Map<string, SubdivisionRecord>();
  for (const n of [s.code, s.name, s.zh, s.zhHant, ...(s.aliases ?? [])]) {
    if (!n) continue;
    const key = geoKey(n);
    if (!map.has(key)) map.set(key, s);
  }
  SUB_BY_COUNTRY.set(s.country, map);
}

/** A subdivision of `country` by code or name. */
export function subdivision(country: string, value: string | null | undefined): SubdivisionRecord | null {
  if (!value) return null;
  return SUB_BY_COUNTRY.get(country.toUpperCase())?.get(geoKey(value)) ?? null;
}

/** Countries in which `value` names a subdivision (e.g. "CA" → US California and nothing else; "WA" → US, AU). */
export function subdivisionCountries(value: string): string[] {
  const key = geoKey(value);
  const out: string[] = [];
  for (const [country, map] of SUB_BY_COUNTRY) if (map.has(key)) out.push(country);
  return out;
}
