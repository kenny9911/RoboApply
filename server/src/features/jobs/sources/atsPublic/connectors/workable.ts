// server/src/features/jobs/sources/atsPublic/connectors/workable.ts — Workable
// (MKT-5B, JI-8; JOB_SOURCES_INTL 3.2 probe 8, 4.4, open question 5).
//
//   GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
//
// The listing Workable-hosted career pages call. It answers without a key
// (probe of 2026-10-11; shape read again on 2026-10-12): the account's `name`
// and `jobs[]` with `title`, `shortcode`, `description` (HTML), `url`,
// `application_url`, `published_on` (a calendar day), `telecommuting`,
// `employment_type`, `experience`, `country` (a name), `city`, `state` and
// `locations[]` (`country`, `countryCode`, `city`, `region`, `hidden`). One
// call lists the whole board with its texts. No pay field was seen: none is
// mapped.
//
// Workable does not document this endpoint for third parties, so it has its
// own kill switch, ATS_WORKABLE_DISABLED (../connectors.ts `connectorEnabled`),
// and the question is with the owner (MARKET_TASK_PLAN, JI-8). Like every
// board it is read once per sync with our identifying User-Agent.
//
// Places. `locations[]` is the posting's list of places, each with a `hidden`
// mark; the top-level `city` / `state` / `country` repeat its first entry,
// hidden or not. A hidden place is not shown by the employer's own board, so
// it is not passed on in any field: when the posting carries `locations[]`,
// the place text, the city, the region and the stated country all come from
// its first SHOWN entry (none shown: the posting states no place), and the
// top-level fields are read only when there is no `locations[]` at all.
//
// Links. `application_url` and `url` are passed on as the board states them
// (`https://apply.workable.com/j/{shortcode}[/apply]`). The posting page under
// the account, `https://apply.workable.com/{slug}/j/{shortcode}`, is the
// source link: it is the address other sources link to, so the row's posting
// key (`workable:{slug}:{shortcode}`, normalize/ats.ts) agrees with theirs.

import type { ProviderJobInput } from '../../../normalize/index.js';
import { BoardFetchError, getJson } from '../http.js';
import { arr, obj, str } from '../shared.js';
import { base, countryFields, enc, httpsUrl, isoCountry, named, uniqueStrings, wholeBoard, type AtsConnector, type BoardSource } from './common.js';

/** "Paris, Île-de-France, France" from the parts the board states, each once. */
function placeText(city: unknown, region: unknown, country: unknown): string | null {
  return uniqueStrings([city, region, country]).join(', ') || null;
}

/** The posting page under the account (see the header). */
export function workablePostingUrl(slug: string, shortcode: string): string {
  return `https://apply.workable.com/${enc(slug)}/j/${enc(shortcode)}`;
}

export function mapWorkableJob(raw: unknown, source: BoardSource, now: Date): ProviderJobInput | null {
  const j = obj(raw);
  const shortcode = j && str(j.shortcode);
  const title = j && str(j.title);
  if (!j || !shortcode || !title) return null;
  const listed = arr(j.locations)
    .map(obj)
    .filter((l): l is Record<string, unknown> => !!l);
  // Places the employer hides are not shown by its own board either: they are passed on in no field (see the header).
  const shown = listed.filter((l) => l.hidden !== true);
  // The posting's own place: the first shown entry, or the top-level fields when the posting has no list of places.
  const own = listed.length > 0 ? (shown[0] ?? null) : { city: j.city, region: j.state, country: j.country, countryCode: null };
  const location = own ? placeText(own.city, own.region, own.country) : null;
  const page = workablePostingUrl(source.boardToken, shortcode);
  const published = str(j.published_on);
  return {
    ...base(source, shortcode, now),
    title,
    applyUrl: httpsUrl(j.application_url) ?? httpsUrl(j.url) ?? page,
    sourceUrl: page,
    location,
    locations: uniqueStrings([location, ...shown.map((l) => placeText(l.city, l.region, l.country))]),
    locationCity: own ? str(own.city) : null,
    locationRegion: own ? str(own.region) : null,
    // The country stated for the place that is passed on, never for another one.
    ...countryFields(own ? (isoCountry(own.countryCode) ?? isoCountry(own.country)) : null, source),
    // Remote only where the board says so; it states no other arrangement.
    workModel: j.telecommuting === true ? 'remote' : null,
    employmentType: str(j.employment_type),
    seniority: str(j.experience),
    descriptionHtml: str(j.description),
    // A calendar day with no time: read as the start of that day.
    postedAt: published,
    postedAtEstimated: !published,
  };
}

export const workable: AtsConnector = {
  ats: 'workable',
  boardUrl: (token) => `https://apply.workable.com/api/v1/widget/accounts/${enc(token)}?details=true`,
  async read(source, deps, opts = {}) {
    const body = obj(await getJson(this.boardUrl(source.boardToken), deps));
    if (!body || !Array.isArray(body.jobs)) throw new BoardFetchError('unexpected_shape');
    // The account's own name: what the board states as the company.
    const boardCompanyName = str(body.name);
    const as = named(source, boardCompanyName);
    const listing = body.jobs.map((raw) => mapWorkableJob(raw, as, deps.now)).filter((x): x is ProviderJobInput => !!x);
    return wholeBoard(listing, opts, 1, boardCompanyName);
  },
};
