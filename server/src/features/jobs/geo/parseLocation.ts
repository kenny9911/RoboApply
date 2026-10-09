// server/src/features/jobs/geo/parseLocation.ts
//
// Posting location text → city / region / country (+ coordinates from the
// city table) and any work-model words the text states (ARCH §4.4).
//
// Handles the shapes providers send: "Austin, TX", "Austin, TX, US",
// "Toronto, ON, Canada", "London, England, United Kingdom", "Remote - US",
// "Hybrid (Taipei City, Taiwan)", "臺北市信義區", "上海市静安区", "新北市, 台灣".
// Rules (D3):
//   - Coordinates only from the table. An unknown city keeps the posting's
//     words and gets no coordinates.
//   - Work-model words count only when the text states them; nothing is
//     inferred from their absence.
//   - `hint.country` (the provider's country for this location) is binding
//     when the text names no country or region code: an ambiguous city
//     resolves inside it ("Cambridge" + GB is Cambridge, England), and a city
//     the table has only elsewhere stays unplaced (no coordinates).
//   - `hint.searchCountry` (the search's country) is weaker: among the table
//     cities a name can mean it picks the one in that country, and it fills a
//     missing country unless a table city lies elsewhere ("Tokyo" stays JP).
//     Either way the result says so (`countrySource: 'hint'`).
//   - "<subdivision>, <country>" ("Washington, United States", "Texas, US") is
//     a state-level location: region set, city null — except for the
//     subdivisions that are themselves cities (Beijing, Shanghai, Delhi …).

import { CJK_COUNTRY_NAMES, countryByCode, countryByName, geoKey, resolveCountry, subdivision, subdivisionCountries, type CountryRecord } from './countries.js';
import { citiesNamed, findCity, scanCjkCities, type CityRecord } from './cities.js';

export type StatedWorkModel = 'remote' | 'hybrid' | 'onsite';

export interface ParsedLocation {
  /** The input text, trimmed. */
  raw: string;
  /** The table entry, when the city is in the table. */
  city: CityRecord | null;
  /** English table name, or the posting's own words for a city not in the table. */
  cityName: string | null;
  /** Subdivision as stored on RAJob.locationRegion (US "TX", CN "Guangdong"). */
  region: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  /** Where `country` came from. */
  countrySource: 'text' | 'city_table' | 'hint' | null;
  lat: number | null;
  lng: number | null;
  /** Work model stated in the location text, else null. */
  workModel: StatedWorkModel | null;
  /** For remote roles: the stated country, 'global' for "anywhere/worldwide", else null. */
  remoteScope: string | null;
}

export interface LocationHint {
  city?: string | null;
  region?: string | null;
  /** ISO code or country name the provider states for this location. Binding when the text names none. */
  country?: string | null;
  /** The search's country (or another weak hint): preferred among same-name cities; fills a missing country. */
  searchCountry?: string | null;
}

/** Subdivisions that are themselves one city: "Beijing, China" names the city, not a province. */
const CITY_LEVEL_SUBDIVISIONS = new Set(['CN:Beijing', 'CN:Shanghai', 'CN:Tianjin', 'CN:Chongqing', 'IN:DL']);

const CJK = /[㐀-鿿豈-﫿]/;

const REMOTE_RE = /\b(remote|fully remote|work from home|wfh|telecommute|telework|anywhere|remote[- ]first)\b|远程|遠端|遠距|居家办公|居家辦公|在家办公|在家辦公/i;
const HYBRID_RE = /\bhybrid\b|混合办公|混合辦公|混合/i;
const ONSITE_RE = /\b(on-?site|in[- ]office|in[- ]person)\b|现场办公|駐點|驻场/i;
const GLOBAL_RE = /\b(anywhere|worldwide|global(?:ly)?|international)\b|全球|不限地点|不限地點/i;
/** "Remote in Canada", "Anywhere in the US", "Work from home within Germany" → "Remote, Canada". */
const REMOTE_IN_RE = /^\s*((?:fully\s+|100%\s+)?remote|anywhere|work from home|wfh)\s+(?:in|within|from|across)\s+(?:the\s+)?/i;

/**
 * Words that carry no place. A token made only of these is dropped. Two-letter
 * words that are also region codes (ON, IN, OR, OK) are matched only inside
 * the phrases below, never alone.
 */
const NOISE_PHRASES = /\b(on[- ]?site|in[- ]office|in[- ]person|remote ok|work from home|remote[- ]first|or|and)\b/g;
const NOISE_WORDS = new Set([
  'remote', 'fully', 'hybrid', 'onsite', 'office', 'person', 'work', 'from', 'home', 'wfh',
  'telecommute', 'telework', 'anywhere', 'worldwide', 'global', 'globally', 'international', 'first',
  'only', 'based', 'position', 'role', 'friendly', 'option', 'optional', 'eligible', 'within',
  'multiple', 'locations', 'location', 'various', 'nationwide', 'flexible', 'tbd', 'n/a',
]);
const NOISE_CJK = /^(远程|遠端|遠距|居家办公|居家辦公|在家办公|在家辦公|混合办公|混合辦公|全国|全國|多地|不限|不限地点|不限地點|全球|多个地点|多個地點)$/;

const SEPARATORS = /\s*(?:[,，、;；|/()（）[\]【】·•]|\s[-–—]\s|^[-–—]\s*|\s*[-–—]$)\s*/;

function emptyResult(raw: string): ParsedLocation {
  return { raw, city: null, cityName: null, region: null, country: null, countrySource: null, lat: null, lng: null, workModel: null, remoteScope: null };
}

/** Work model stated in a short text (title or location), or null when none / conflicting. */
export function statedWorkModel(text: string | null | undefined): StatedWorkModel | null {
  if (!text) return null;
  const s = text.normalize('NFKC');
  const remote = REMOTE_RE.test(s) && !/\b(not|no|non)[- ]remote\b/i.test(s);
  const hybrid = HYBRID_RE.test(s);
  const onsite = ONSITE_RE.test(s);
  const hits = [remote && 'remote', hybrid && 'hybrid', onsite && 'onsite'].filter(Boolean) as StatedWorkModel[];
  return hits.length === 1 ? hits[0] : null;
}

function isNoiseToken(token: string): boolean {
  if (!token) return true;
  if (NOISE_CJK.test(token)) return true;
  if (CJK.test(token)) return false;
  // Lower-case 'or' / 'and' are connectors; upper-case OR stays a region code (Oregon).
  const lowered = token === token.toUpperCase() ? token : geoKey(token).replace(NOISE_PHRASES, ' ');
  const words = geoKey(lowered)
    .replace(/[^a-z0-9/\- ]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  return words.length === 0 || words.every((w) => NOISE_WORDS.has(w));
}

/** "Greater Boston Area" → "Boston"; "Seattle Metro" → "Seattle". */
function cleanPlaceToken(token: string): string {
  return token
    .replace(/^greater\s+/i, '')
    .replace(/\s+(metropolitan area|metro area|metro|area|region)$/i, '')
    .trim();
}

function splitTokens(text: string): string[] {
  return text
    .split(SEPARATORS)
    .map((t) => t.replace(/\s+\d{3,6}(?:-\d{4})?$/, '').trim()) // trailing postal codes
    .filter((t) => t && !isNoiseToken(t));
}

interface TwoLetter {
  token: string;
  iso: CountryRecord | null;
  regionOf: string[];
}

/** Country named by a full name / alias (not a bare two-letter code), or a CJK name inside the text. */
function namedCountry(token: string): CountryRecord | null {
  if (/^[A-Za-z]{2}$/.test(token)) return token.toUpperCase() === 'UK' ? countryByCode('GB') : null;
  return countryByName(token);
}

function scanCjkCountry(text: string): CountryRecord | null {
  for (const { text: name, country } of CJK_COUNTRY_NAMES) if (text.includes(name)) return country;
  return null;
}

/**
 * Parse one location text. `hint` carries structured fields a provider sent
 * separately (city / region / country) and the search's country.
 */
export function parseLocation(text: string | null | undefined, hint: LocationHint = {}): ParsedLocation {
  const raw = (text ?? '').normalize('NFKC').trim();
  const out = emptyResult(raw);
  const combined = [raw, hint.city ?? ''].join(' ');
  out.workModel = statedWorkModel(raw);
  const isGlobal = GLOBAL_RE.test(raw);

  const tokens = splitTokens(raw.replace(REMOTE_IN_RE, '$1, '));
  if (hint.city && !tokens.some((t) => geoKey(t) === geoKey(hint.city!))) tokens.unshift(hint.city.trim());

  // 1. Countries named in full (or by alias) anywhere after the first token, or as the only token.
  let country: CountryRecord | null = null;
  const consumed = new Set<number>();
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (i === 0 && tokens.length > 1) break;
    let c = namedCountry(tokens[i]);
    // A last-position ISO code that is no subdivision anywhere ("US", "GB", "TW", "SG").
    if (!c && i === tokens.length - 1 && /^[A-Z]{2}$/.test(tokens[i]) && !subdivisionCountries(tokens[i]).length) c = countryByCode(tokens[i]);
    if (c) {
      country = c;
      consumed.add(i);
      break;
    }
  }
  if (!country && CJK.test(combined)) country = scanCjkCountry(combined);
  let countrySource: ParsedLocation['countrySource'] = country ? 'text' : null;

  // 2. Two-letter tokens after the first: a region code, an ISO country code, or both ("CA", "WA").
  const twoLetter: TwoLetter[] = [];
  const lone = tokens.length === 1;
  tokens.forEach((t, i) => {
    if ((i === 0 && !lone) || consumed.has(i) || !/^[A-Za-z]{2,3}$/.test(t)) return;
    const entry = { token: t, iso: t.length === 2 ? countryByCode(t) : null, regionOf: subdivisionCountries(t) };
    if (entry.iso || entry.regionOf.length) twoLetter.push(entry);
  });

  // 3. The city: the first token that names a table city consistent with what the text states.
  let city: CityRecord | null = null;
  let cityToken: string | null = null;
  const regionTokens = tokens.filter((_, i) => (i > 0 || lone) && !consumed.has(i));
  const statedRegionFor = (countryCode: string): string | null => {
    for (const t of regionTokens) {
      const sub = subdivision(countryCode, t) ?? subdivision(countryCode, t.replace(/\s+(province|state|county)$/i, ''));
      if (sub) return sub.code;
    }
    if (hint.region) return subdivision(countryCode, hint.region)?.code ?? null;
    return null;
  };
  const hintCountry = resolveCountry(hint.country);
  const consistent = (c: CityRecord): boolean => {
    // A stated region that contradicts the table's region rules the entry out ("Portland, ME" is not Portland, OR).
    const stated = statedRegionFor(c.country);
    if (stated && c.region && geoKey(stated) !== geoKey(c.region)) return false;
    if (country) return c.country === country.code;
    if (twoLetter.length) return twoLetter.some((t) => t.iso?.code === c.country || t.regionOf.includes(c.country));
    // The text names no country: the provider's country binds.
    if (hintCountry) return c.country === hintCountry.code;
    return true;
  };
  const searchCountry = resolveCountry(hint.searchCountry);
  /** Among same-name cities: the search's country first, then the hinted region, then table order. */
  const pick = (pool: readonly CityRecord[]): CityRecord => {
    let list = pool;
    if (searchCountry && list.some((c) => c.country === searchCountry.code)) list = list.filter((c) => c.country === searchCountry.code);
    const inRegion = (c: CityRecord) => !!c.region && geoKey(subdivision(c.country, hint.region)?.code ?? hint.region ?? '') === geoKey(c.region);
    return (hint.region ? list.find(inRegion) : undefined) ?? list[0];
  };

  // "Washington, United States" / "Texas, US": a subdivision of the stated country and nothing else.
  const rest = tokens.filter((_, i) => !consumed.has(i));
  const stateSub = country && !hint.city && rest.length === 1 ? subdivision(country.code, rest[0]) : null;
  const stateOnly = !!stateSub && !CITY_LEVEL_SUBDIVISIONS.has(`${stateSub.country}:${stateSub.code}`);

  for (let i = 0; i < tokens.length && !city && !stateOnly; i++) {
    if (consumed.has(i)) continue;
    const tok = tokens[i];
    for (const candidate of [tok, cleanPlaceToken(tok)]) {
      const pool = citiesNamed(candidate).filter(consistent);
      if (!pool.length) continue;
      city = pick(pool);
      cityToken = tok;
      break;
    }
  }
  if (!city && !stateOnly && CJK.test(raw)) {
    city = scanCjkCities(raw, country?.code ?? null);
    if (city) cityToken = raw;
  }

  // 4. Country from the city, then from two-letter tokens.
  if (!country && city) {
    country = countryByCode(city.country);
    countrySource = 'city_table';
  }
  if (!country && twoLetter.length) {
    const pair = twoLetter.find((t) => t.iso && twoLetter.some((r) => r !== t && r.regionOf.includes(t.iso!.code)));
    const usState = twoLetter.find((t) => t.regionOf.includes('US') && t.token === t.token.toUpperCase());
    const single = twoLetter.find((t) => t.regionOf.length === 1);
    const isoOnly = twoLetter.find((t) => t.iso && !t.regionOf.length);
    const picked = pair?.iso ?? (usState ? countryByCode('US') : null) ?? (single ? countryByCode(single.regionOf[0]) : null) ?? isoOnly?.iso ?? null;
    if (picked) {
      country = picked;
      countrySource = 'text';
    }
  }
  const fill = hintCountry ?? searchCountry;
  if (!country && fill && (!city || city.country === fill.code)) {
    country = fill;
    countrySource = 'hint';
  }
  // A city-state named only as a country ("Singapore", "Hong Kong").
  if (!city && country && tokens.length <= 2) {
    city = findCity(country.name, { country: country.code });
    if (city) cityToken = country.name;
  }

  out.country = country?.code ?? null;
  out.countrySource = out.country ? countrySource : null;
  out.region = stateOnly ? stateSub!.code : out.country ? (statedRegionFor(out.country) ?? city?.region ?? null) : null;
  if (city) {
    out.city = city;
    out.cityName = city.name;
    out.lat = city.lat;
    out.lng = city.lng;
  } else {
    // Keep the posting's own words for a city we cannot place (no coordinates).
    const first = tokens.find((t, i) => !consumed.has(i) && !(out.country && subdivision(out.country, t)) && !namedCountry(t) && !twoLetter.some((c) => c.token === t));
    out.cityName = first && first !== cityToken ? cleanPlaceToken(first) || null : null;
  }

  if (out.workModel === 'remote') {
    // A named country scopes the role ("Anywhere in the US" is US-only); 'global' only when none is named.
    const named = out.countrySource === 'text' || out.countrySource === 'city_table' ? out.country : null;
    out.remoteScope = named ?? (isGlobal ? 'global' : null);
  }
  return out;
}

/** Parse several location texts (multi-location postings); entries for the same place collapse. */
export function parseLocations(texts: readonly (string | null | undefined)[], hint: LocationHint = {}): ParsedLocation[] {
  const out: ParsedLocation[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    if (!t || !t.trim()) continue;
    const p = parseLocation(t, hint);
    const key = p.city?.id ?? `${p.cityName ?? ''}|${p.region ?? ''}|${p.country ?? ''}|${p.workModel ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
