// server/src/features/jobs/geo/twSearch.ts — Taiwan searches and the district
// filter's values (MKT-5F; MARKET_STRATEGY §2.5, §9.5 JT-7).
//
// Two questions the filter contract (features/search), the feed predicates
// (features/feed/sql.ts) and the Taiwan routes (features/tw) ask, answered in
// one place from the two tables this folder already holds (the city table and
// the 22 counties with their 鄉鎮市區):
//
//   1. Is a search in Taiwan? Its country is TW, or one of its places is in
//      Taiwan: the place says so (`country: 'TW'`), its text starts with one
//      of the 22 county names (新竹縣, 臺北市信義區), or the city table places
//      its name in Taiwan (Taipei, 台北, Hsinchu County). A place that states
//      another country is never in Taiwan, whatever its name.
//
//   2. Which district does a filter value mean? A value is `<county><district>`
//      as postings write it (新竹縣竹北市, 臺北市士林區): the county is part of
//      the value because a district name alone does not say where it is
//      (東區 is a district of four counties; 中正區, 信義區 and 中山區 are
//      districts of both 台北市 and 基隆市, 25 km apart). A bare name is taken
//      only when one county alone has it (竹北市). Anything else is not a
//      district of the table and resolves to null: never a guess (D3).
//
// A job row stores the bare district (`RAJob.locationDistrict` = 竹北市) and
// its county only as the city the city table gave it (`locationCity`), so for
// a shared name the feed pairs the district with that city's names
// (`twCountyCityNames`). The 22 counties map onto 20 city records: 嘉義市 and
// 嘉義縣 share one, and 連江縣 has none (its four districts are its alone, so
// they never need the pair).
//
// Pure: no I/O, no clock.

import { findCity } from './cities.js';
import { TW_COUNTIES, TW_DISTRICTS, findTwDistrict, type TwCounty, type TwDistrict } from './twDistricts.js';

/** One place of a search, structurally (a `FilterLocation` fits). */
export interface SearchPlace {
  label: string;
  city?: string;
  country?: string;
}

/** The location part of a search, structurally (a `FilterSet` fits). */
export interface SearchPlaces {
  country?: string;
  locations?: readonly SearchPlace[];
}

/** 台 and 臺 are one character here; width, case and spaces do not matter. */
function fold(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台').toLowerCase();
}

const namesOf = (row: TwDistrict): string[] => (row.districts?.length ? row.districts : [row.district]);

/** Every (county, district name) of the table, keyed by the folded bare name. */
const BY_BARE_NAME = new Map<string, Array<{ row: TwDistrict; name: string }>>();
for (const row of TW_DISTRICTS) {
  for (const name of namesOf(row)) {
    const key = fold(name);
    BY_BARE_NAME.set(key, [...(BY_BARE_NAME.get(key) ?? []), { row, name }]);
  }
}

const COUNTY_BY_CODE = new Map<string, TwCounty>(TW_COUNTIES.map((c) => [c.code, c]));

/** The city-table record a county's name resolves to, per county code (null: the table does not have it). */
const CITY_OF_COUNTY = new Map(TW_COUNTIES.map((c) => [c.code, findCity(c.name, { country: 'TW' })] as const));

/** The first place name of a label: "Taipei, Taiwan" → "Taipei". */
const firstName = (place: SearchPlace): string => (place.city?.trim() || place.label).split(/[,，]/)[0]?.trim() ?? '';

/**
 * The counties a search place names: the county its text starts with, else the
 * counties whose city-table record carries its name (one record can stand for
 * two counties: "Chiayi" is 嘉義市 and 嘉義縣). Empty for a place that states
 * another country, and for a name that is no Taiwanese place.
 */
export function twCountiesOfPlace(place: SearchPlace): TwCounty[] {
  const stated = place.country?.trim().toUpperCase();
  if (stated && stated !== 'TW') return [];
  for (const text of [place.label, place.city ?? '']) {
    const hit = findTwDistrict(text);
    if (hit) return [COUNTY_BY_CODE.get(hit.countyCode)!];
  }
  const city = findCity(firstName(place), { country: stated ?? null });
  if (!city || city.country !== 'TW') return [];
  return TW_COUNTIES.filter((c) => CITY_OF_COUNTY.get(c.code)?.id === city.id);
}

/** True when the place is in Taiwan: it says so, or its name is a Taiwanese county or city. */
export function isTaiwanPlace(place: SearchPlace): boolean {
  const stated = place.country?.trim().toUpperCase();
  if (stated) return stated === 'TW';
  if (findTwDistrict(place.label) || findTwDistrict(place.city)) return true;
  return findCity(firstName(place))?.country === 'TW';
}

/** True when a search is in Taiwan: its country is TW, or one of its places is in Taiwan. */
export function isTaiwanSearch(search: SearchPlaces | null | undefined): boolean {
  if (!search) return false;
  if (search.country?.trim().toUpperCase() === 'TW') return true;
  return (search.locations ?? []).some(isTaiwanPlace);
}

/** One district of the table, as a filter value resolves to it. */
export interface TwDistrictRef {
  countyCode: string;
  /** The county's name in the table's spelling (台北市). */
  county: string;
  /** The district as the postal list writes it, and as `RAJob.locationDistrict` stores it (竹北市). */
  district: string;
  zip3: string;
  /** The canonical filter value: `<county><district>` (新竹縣竹北市). */
  value: string;
}

function toRef(row: TwDistrict, name: string): TwDistrictRef {
  return { countyCode: row.countyCode, county: row.county, district: name, zip3: row.zip3, value: `${row.county}${name}` };
}

/**
 * The district a filter value means, or null when it names none of the table:
 * `<county><district>` in either spelling of the county (臺北市士林區), or a
 * bare district name that exactly one county has (竹北市). A bare name several
 * counties share (東區), a county alone (台中市, 台中市不限) and free text are
 * null. Pure; never throws.
 */
export function resolveTwDistrictValue(value: string | null | undefined): TwDistrictRef | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const full = findTwDistrict(value);
  if (full) {
    if (!full.district || !full.zip3) return null;
    // The whole value is the county and the district, nothing after them.
    if (fold(value) !== fold(`${full.county}${full.district}`)) return null;
    return { countyCode: full.countyCode, county: full.county, district: full.district, zip3: full.zip3, value: `${full.county}${full.district}` };
  }
  const bare = BY_BARE_NAME.get(fold(value)) ?? [];
  return bare.length === 1 ? toRef(bare[0]!.row, bare[0]!.name) : null;
}

/** True when more than one county has a district of this name (東區, 中正區, 信義區 …). */
export function twDistrictNameIsShared(district: string): boolean {
  return (BY_BARE_NAME.get(fold(district)) ?? []).length > 1;
}

/**
 * The names `RAJob.locationCity` can hold for a posting in this county (the
 * city-table record its name resolves to: English, both Chinese scripts and
 * the aliases), lower-cased. Empty when the table has no record for the
 * county (連江縣).
 */
export function twCountyCityNames(countyCode: string): string[] {
  const city = CITY_OF_COUNTY.get(countyCode);
  if (!city) return [];
  const names = [city.name, city.zh, city.zhHant, ...(city.aliases ?? [])].filter((n): n is string => !!n);
  return [...new Set(names.map((n) => n.normalize('NFKC').trim().toLowerCase()).filter(Boolean))];
}

/**
 * The names a search place may use for a county, for a client that has to
 * tell whether a location someone typed is this county (the filters drawer):
 * the county's own two spellings, and the names of its city-table record that
 * are not another county's own name. Each is folded the way `twPlaceKey`
 * folds a typed label, so the client compares keys and needs no table of its
 * own.
 */
export function twCountyKeys(county: TwCounty): string[] {
  const own = [county.name, county.nameAlt].filter((n): n is string => !!n);
  const otherCounties = new Set(TW_COUNTIES.filter((c) => c.code !== county.code).flatMap((c) => [c.name, c.nameAlt ?? '']).filter(Boolean).map(twPlaceKey));
  const city = CITY_OF_COUNTY.get(county.code);
  const fromCity = city ? [city.name, `${city.name} City`, city.zh, city.zhHant, ...(city.aliases ?? [])].filter((n): n is string => !!n) : [];
  return [...new Set([...own, ...fromCity].map(twPlaceKey).filter((k) => k && !otherCounties.has(k)))];
}

/**
 * The comparison key of a place name: width and case folded, 臺 read as 台,
 * runs of spaces as one. Deliberately simple: lib/api/tw.ts holds the same
 * four steps for the labels people type.
 */
export function twPlaceKey(text: string): string {
  return text.normalize('NFKC').replace(/臺/g, '台').replace(/\s+/g, ' ').trim().toLowerCase();
}
