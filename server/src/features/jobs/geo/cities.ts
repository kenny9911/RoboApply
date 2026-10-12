// server/src/features/jobs/geo/cities.ts
//
// The static city table (geo/cities.json) and its lookups. Coordinates come
// only from the table; a city that is not in the table keeps the name the
// posting gave and gets no coordinates (D3: no geocoding guesses).
//
// Ambiguous names ("Cambridge", "Birmingham", "Portland") resolve with the
// country and region the posting states; without them the first entry in
// table order wins.

import data from './cities.json' with { type: 'json' };
import { geoKey } from './countries.js';

export interface CityRecord {
  /** Stable id: '<country>-<slug>' (e.g. 'us-austin', 'tw-taipei'). */
  id: string;
  /** English name. */
  name: string;
  /** Simplified Chinese name (mainland usage). */
  zh?: string;
  /** Traditional Chinese name (Taiwan usage). */
  zhHant?: string;
  aliases?: readonly string[];
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Same convention as SubdivisionRecord.code (US "TX", CN "Guangdong", GB "England"). */
  region?: string;
  lat: number;
  lng: number;
}

export interface CityTableSource {
  id: string;
  name: string;
  publisher: string;
  url: string | null;
  license: string;
  notes?: string;
}

export interface CityTable {
  version: number;
  asOf: string;
  source: CityTableSource;
  cities: CityRecord[];
}

const TABLE = data as CityTable;

export const CITY_TABLE_VERSION = TABLE.version;
export const CITY_TABLE_AS_OF = TABLE.asOf;
export const CITY_TABLE_SOURCE: Readonly<CityTableSource> = TABLE.source;
export const CITIES: readonly CityRecord[] = TABLE.cities;

const CJK = /[㐀-鿿豈-﫿]/;

/** Key used for city matching: geoKey plus trailing " city" removed ("Taipei City" → "taipei"). */
export function cityKey(input: string): string {
  return geoKey(input)
    .replace(/[’']/g, '')
    .replace(/\s+city$/, '')
    .trim();
}

const BY_ID = new Map(CITIES.map((c) => [c.id, c]));
const BY_KEY = new Map<string, CityRecord[]>();
/** `short`: a two-character alias (a district such as 三重 / 中和 / 內湖) — easy to meet inside other words. */
const CJK_NAMES: { text: string; city: CityRecord; short: boolean }[] = [];

for (const city of CITIES) {
  const own = new Set([city.name, city.zh, city.zhHant].filter((n): n is string => !!n));
  const names = [city.name, city.zh, city.zhHant, ...(city.aliases ?? [])].filter((n): n is string => !!n);
  const seen = new Set<string>();
  for (const n of names) {
    const key = cityKey(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const list = BY_KEY.get(key) ?? [];
    list.push(city);
    BY_KEY.set(key, list);
    if (CJK.test(n)) CJK_NAMES.push({ text: n.normalize('NFKC'), city, short: !own.has(n) && [...n].length <= 2 });
  }
}

/** Japanese place text (kana, or the 県 prefecture suffix): never scanned for Chinese city names (三重県 is Mie, Japan). */
const JAPANESE_RE = /[\u3040-\u30ff県]/;
/** What may follow a district alias for it to count ("三重區", "中和区"). */
const DISTRICT_SUFFIX_RE = /^(?:區|区|市|縣|县|鎮|镇|鄉|乡)/;
CJK_NAMES.sort((a, b) => b.text.length - a.text.length);

export function cityById(id: string | null | undefined): CityRecord | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** Every table entry a name can mean, in table order. */
export function citiesNamed(name: string): readonly CityRecord[] {
  return BY_KEY.get(cityKey(name)) ?? [];
}

/**
 * The table entry for a city name, preferring one in `country` (and `region`
 * when given). Returns null when the name is unknown, or when a country is
 * given and no entry with that name lies in it.
 */
export function findCity(name: string | null | undefined, hint: { country?: string | null; region?: string | null } = {}): CityRecord | null {
  if (!name) return null;
  const candidates = citiesNamed(name);
  if (!candidates.length) return null;
  const country = hint.country?.toUpperCase() ?? null;
  const pool = country ? candidates.filter((c) => c.country === country) : candidates;
  if (!pool.length) return null;
  if (hint.region) {
    const region = geoKey(hint.region);
    const inRegion = pool.find((c) => c.region && geoKey(c.region) === region);
    if (inRegion) return inRegion;
  }
  return pool[0];
}

/**
 * Cities named inside unseparated CJK text ("臺北市信義區", "上海市静安区"):
 * the longest name wins, then the earliest position.
 */
export function scanCjkCities(text: string, country?: string | null): CityRecord | null {
  const s = text.normalize('NFKC');
  if (!CJK.test(s) || JAPANESE_RE.test(s)) return null;
  let best: { city: CityRecord; len: number; pos: number } | null = null;
  for (const { text: name, city, short } of CJK_NAMES) {
    if (country && city.country !== country.toUpperCase()) continue;
    if (best && name.length < best.len) break;
    const pos = s.indexOf(name);
    if (pos < 0) continue;
    // A two-character district alias counts as a whole text, before 區/区/市…, or after its city's own name ("新北市三重").
    if (short && s.trim() !== name) {
      const after = s.slice(pos + name.length);
      const ownBefore = [city.zh, city.zhHant].some((n) => !!n && s.slice(0, pos).includes(n));
      if (!DISTRICT_SUFFIX_RE.test(after) && !ownBefore) continue;
    }
    if (!best || name.length > best.len || pos < best.pos) best = { city, len: name.length, pos };
  }
  return best?.city ?? null;
}

/** A city label for a locale: zh → Simplified, zh-TW / zh-HK → Traditional, else English. */
export function cityLabel(city: CityRecord, locale: string): string {
  if (locale === 'zh' || locale === 'zh-CN') return city.zh ?? city.name;
  if (locale === 'zh-TW' || locale === 'zh-HK') return city.zhHant ?? city.zh ?? city.name;
  return city.name;
}

/** Great-circle distance in km (haversine), for radius filters and tests. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Structural problems in a city table (empty when valid). */
export function validateCityTable(t: CityTable, knownCountries: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const c of t.cities) {
    if (ids.has(c.id)) errors.push(`duplicate id ${c.id}`);
    ids.add(c.id);
    if (!/^[a-z]{2}-[a-z0-9-]+$/.test(c.id)) errors.push(`bad id ${c.id}`);
    if (!c.id.startsWith(`${c.country.toLowerCase()}-`)) errors.push(`${c.id}: id prefix does not match country ${c.country}`);
    if (!knownCountries.has(c.country)) errors.push(`${c.id}: unknown country ${c.country}`);
    if (!c.name?.trim()) errors.push(`${c.id}: no name`);
    if (!(c.lat >= -90 && c.lat <= 90) || !(c.lng >= -180 && c.lng <= 180)) errors.push(`${c.id}: coordinates out of range`);
  }
  if (!t.source?.id || !t.source?.license) errors.push('source and license are required');
  return errors;
}
