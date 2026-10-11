// server/src/features/jobs/sources/atsPublic/market.ts — which market a board
// posting belongs to (MARKET_STRATEGY 1.4 tier 1, JC-4; critic C9).
//
// A board is read ONCE and feeds both brands. Each posting lands in the market
// of its own location: mainland China -> cn (GoApply), anything else -> intl
// (RoboApply). Hong Kong, Macau and Taiwan are not mainland. The decision per
// location is the normalizer's own (`marketOfPosting`, normalize/), asked for
// one location at a time, so this file and the normalizer cannot disagree:
//
//   only mainland locations              -> one copy, market cn, the plain externalId
//   only other, unknown or remote ones   -> one copy, market intl
//   locations on both sides              -> two copies: intl keeps the externalId
//                                           and the locations outside the mainland,
//                                           cn gets `<externalId>#cn` and only the
//                                           mainland locations
//
// (externalId, sourceBoard) is unique and a row is in exactly one market, which
// is why the mainland copy of a two-sided posting carries the suffix.
//
// A location counts for a side only when the posting itself places it: the
// text names a country or a known city, or the board states the country for
// it. A text that places nothing ("Remote", "Multiple locations") never makes a
// posting two-sided; it stays with the copy that holds the posting's first
// location, or with the international copy.
//
// Then the source's `countries`: with a non-empty list a copy is kept only
// when one of its placed countries is in the list, or it is a remote posting
// that names no country. A copy left out is counted (`country_not_selected`)
// and never written.
//
// The same routing is applied to the listing, which gives the externalIds the
// board's postings map to right now: the closure diff compares our open rows
// against that set, so a posting that drops its Shanghai location closes its
// `#cn` row and keeps the other.

import type { Market } from '../../../../platform/brand/index.js';
import { parseLocation, resolveCountry } from '../../geo/index.js';
import { marketOfPosting, type ProviderJobInput } from '../../normalize/index.js';
import { normalizeCountries } from './shared.js';

/** Appended to the externalId of the mainland copy of a posting located in both markets. */
export const CN_COPY_SUFFIX = '#cn';

/** The posting a stored row belongs to: the row's externalId without the mainland copy's suffix. */
export function postingIdOf(externalId: string): string {
  return externalId.endsWith(CN_COPY_SUFFIX) ? externalId.slice(0, -CN_COPY_SUFFIX.length) : externalId;
}

/** The externalIds a posting can be stored under: its own, and `<id>#cn` for its mainland copy. */
export function copyIdsOf(postingExternalId: string): [string, string] {
  return [postingExternalId, `${postingExternalId}${CN_COPY_SUFFIX}`];
}

/** One copy of a posting, in the market it is written to. */
export interface RoutedPosting {
  market: Market;
  input: ProviderJobInput;
  /** Countries the posting itself places this copy in (ISO alpha-2, upper case). */
  countries: string[];
  /** A remote posting that names no country. */
  remoteAnywhere: boolean;
}

export interface MarketSplit {
  intl: ProviderJobInput | null;
  cn: ProviderJobInput | null;
}

interface Place {
  text: string;
  mainland: boolean;
  /** The posting places this location (see the header). */
  placed: boolean;
  country: string | null;
  remote: boolean;
}

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The posting's location texts in the normalizer's order (`locations`, then `location`), each once. */
function locationTexts(input: ProviderJobInput): string[] {
  const out: string[] = [];
  for (const t of [...(input.locations ?? []), input.location]) {
    const text = clean(t);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** The country the board states for the posting (binding for its first location), or null when it is only a tag. */
function statedCountry(input: ProviderJobInput): string | null {
  return input.locationCountryEstimated ? null : clean(input.locationCountry);
}

/** A weak country hint (a board tag, or the stated country seen from a later location). */
function weakCountry(input: ProviderJobInput): string | null {
  return clean(input.locationCountry);
}

/**
 * The posting as if `texts` were its only locations. The board's separate
 * city / region / country fields describe the first location only, so a copy
 * that does not start with it keeps the country as a weak hint and drops the
 * rest (the normalizer's own rule for later locations).
 */
function withLocations(input: ProviderJobInput, texts: readonly string[], keepsFirst: boolean): ProviderJobInput {
  const copy: ProviderJobInput = { ...input, location: texts[0] ?? null, locations: [...texts] };
  if (!keepsFirst) {
    copy.locationCity = null;
    copy.locationRegion = null;
    copy.locationCountry = weakCountry(input);
    copy.locationCountryEstimated = true;
  }
  return copy;
}

function placeOf(input: ProviderJobInput, text: string, first: boolean): Place {
  const stated = statedCountry(input);
  const weak = weakCountry(input);
  const parsed = parseLocation(
    text,
    first ? { city: clean(input.locationCity), region: clean(input.locationRegion), country: stated, searchCountry: input.locationCountryEstimated ? weak : null } : { searchCountry: weak },
  );
  const mainland = marketOfPosting(withLocations(input, [text], first)) === 'cn';
  // A country that only came from a hint places nothing, unless the board states it for this (the first) location.
  const ownCountry = parsed.country && (parsed.countrySource !== 'hint' || (first && !!stated)) ? parsed.country : null;
  const country = mainland ? 'CN' : ownCountry;
  return { text, mainland, placed: mainland || !!country, country, remote: parsed.workModel === 'remote' };
}

function saysRemote(input: ProviderJobInput): boolean {
  return typeof input.workModel === 'string' && /remote|telecommut|遠端|远程/i.test(input.workModel);
}

function routed(market: Market, input: ProviderJobInput, places: readonly Place[], remoteField: boolean): RoutedPosting {
  const countries = normalizeCountries(places.map((p) => p.country));
  return { market, input, countries, remoteAnywhere: countries.length === 0 && (remoteField || places.some((p) => p.remote)) };
}

/** A posting with no location text: only the board's separate fields say where it is. */
function routeByFieldsOnly(input: ProviderJobInput): RoutedPosting[] {
  const market = marketOfPosting(input);
  const stated = resolveCountry(statedCountry(input) ?? '')?.code ?? null;
  const countries = market === 'cn' ? ['CN'] : stated ? [stated] : [];
  return [{ market, input, countries, remoteAnywhere: countries.length === 0 && saysRemote(input) }];
}

/**
 * The copies a posting is written as: one, or two for a posting located in
 * both markets (see the header). Every copy's market is what the normalizer
 * decides for that copy; if a built copy and the normalizer ever disagreed the
 * posting falls back to one unchanged copy in the normalizer's market.
 */
export function routePosting(input: ProviderJobInput): RoutedPosting[] {
  const texts = locationTexts(input);
  if (texts.length === 0) return routeByFieldsOnly(input);
  const places = texts.map((text, i) => placeOf(input, text, i === 0));
  const remoteField = saysRemote(input);
  const mainland = places.filter((p) => p.mainland);
  const elsewhere = places.filter((p) => p.placed && !p.mainland);
  const whole = (market: Market): RoutedPosting[] => [routed(market, input, market === 'cn' ? mainland : places.filter((p) => !p.mainland), remoteField)];

  if (mainland.length === 0) {
    // Nothing mainland: one international copy. The normalizer has the last word on a place it reads differently.
    return whole(marketOfPosting(input));
  }
  if (elsewhere.length === 0) {
    if (marketOfPosting(input) === 'cn') return whole('cn');
    // The posting's first words place nothing ("Asia Pacific", then "China"): keep the mainland locations only.
    const only = withLocations(input, mainland.map((p) => p.text), mainland[0] === places[0]);
    return marketOfPosting(only) === 'cn' ? [routed('cn', only, mainland, remoteField)] : whole(marketOfPosting(input));
  }
  // Both sides. Texts that place nothing stay with the international copy.
  const outside = places.filter((p) => !p.mainland);
  const intl = withLocations(input, outside.map((p) => p.text), outside[0] === places[0]);
  const cn = { ...withLocations(input, mainland.map((p) => p.text), mainland[0] === places[0]), externalId: `${input.externalId}${CN_COPY_SUFFIX}` };
  if (marketOfPosting(intl) !== 'intl' || marketOfPosting(cn) !== 'cn') return whole(marketOfPosting(input));
  return [routed('intl', intl, outside, remoteField), routed('cn', cn, mainland, remoteField)];
}

/** `routePosting` as the two markets (null = no copy for that market). */
export function splitPostingByMarket(input: ProviderJobInput): MarketSplit {
  const out: MarketSplit = { intl: null, cn: null };
  for (const copy of routePosting(input)) out[copy.market] = copy.input;
  return out;
}

/** Does the source's `countries` keep this copy? An empty list keeps everything. */
export function copySelected(copy: Pick<RoutedPosting, 'countries' | 'remoteAnywhere'>, countries: readonly string[] | null | undefined): boolean {
  const wanted = normalizeCountries(countries);
  if (wanted.length === 0) return true;
  return copy.remoteAnywhere || copy.countries.some((c) => wanted.includes(c));
}

/** The copies of a posting the source keeps, and how many it leaves out (`left`: the markets of those). */
export function selectedCopies(input: ProviderJobInput, countries: readonly string[] | null | undefined): { kept: RoutedPosting[]; countryNotSelected: number; left: Market[] } {
  const copies = routePosting(input);
  const kept = copies.filter((c) => copySelected(c, countries));
  const left = copies.filter((c) => !kept.includes(c)).map((c) => c.market);
  return { kept, countryNotSelected: left.length, left };
}

export interface RoutedBoard {
  /** The postings to write, per market (each with the externalId it is stored under). */
  byMarket: Record<Market, ProviderJobInput[]>;
  /** Every externalId the board's listing maps to right now (the closure diff's "still listed" set). */
  listedIds: string[];
  /** Copies left out because their country is not one the board is read for. */
  countryNotSelected: number;
  /** The same count by the market each left-out copy belonged to. */
  countryNotSelectedByMarket: Record<Market, number>;
}

/**
 * Routes one board read: `listing` is every posting the board lists (enough
 * to place it), `inputs` the postings whose text was read this run.
 */
export function routeBoardRead(read: { listing: readonly ProviderJobInput[]; inputs: readonly ProviderJobInput[] }, countries: readonly string[] | null | undefined): RoutedBoard {
  const listed = new Set<string>();
  for (const posting of read.listing) for (const copy of selectedCopies(posting, countries).kept) listed.add(copy.input.externalId);
  const byMarket: Record<Market, ProviderJobInput[]> = { intl: [], cn: [] };
  const countryNotSelectedByMarket: Record<Market, number> = { intl: 0, cn: 0 };
  let countryNotSelected = 0;
  for (const posting of read.inputs) {
    const { kept, left } = selectedCopies(posting, countries);
    countryNotSelected += left.length;
    for (const market of left) countryNotSelectedByMarket[market] += 1;
    for (const copy of kept) byMarket[copy.market].push(copy.input);
  }
  return { byMarket, listedIds: [...listed], countryNotSelected, countryNotSelectedByMarket };
}

/** The externalIds a listed posting is stored under, given the markets this deployment writes. */
export function storedIdsOf(input: ProviderJobInput, countries: readonly string[] | null | undefined, markets: readonly Market[]): string[] {
  return selectedCopies(input, countries)
    .kept.filter((c) => markets.includes(c.market))
    .map((c) => c.input.externalId);
}
