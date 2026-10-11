// server/src/features/jobs/sources/atsPublic/connectors/recruitee.ts — Recruitee
// (MKT-5B, JI-8; JOB_SOURCES_INTL 4.4).
//
//   GET https://{company}.recruitee.com/api/offers/
//
// Recruitee's Careers Site API, which its documentation says needs no
// authorisation (docs.recruitee.com/reference/offers, read 2026-10-12). The
// answer is `{ offers: [...] }`; one call lists the whole board with its
// texts. Fields read, as documented: `id`, `slug`, `title`, `status`,
// `careers_url`, `published_at` and `close_at` ("YYYY-MM-DD HH:MM:SS UTC"),
// `description` and `requirements` (HTML), `remote` / `hybrid` / `on_site`,
// `locations[]` (`city`, `state`, `country`, `country_code`),
// `employment_type_code`, `experience_code`, `salary` (`min`, `max`, `period`,
// `currency`) and `company_name`. Older payloads state the place on the offer
// itself (`city`, `country`, `country_code`, `location`): read when present.
//
// Never read: `mailbox_email` (the offer's inbound mailbox), the application
// form settings and the sharing fields. The board id is the tenant's
// sub-domain label; ../http.ts allows `<label>.recruitee.com` and nothing else
// on that domain.

import type { ProviderJobInput } from '../../../normalize/index.js';
import { BoardFetchError, getJson } from '../http.js';
import { arr, num, obj, str } from '../shared.js';
import { base, countryFields, enc, httpsUrl, isoCountry, named, uniqueStrings, wholeBoard, type AtsConnector, type BoardSource } from './common.js';

/** "2026-09-26 10:46:21 UTC" -> "2026-09-26T10:46:21Z"; an ISO time passes through; anything else is null. */
export function recruiteeTime(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?:UTC|Z)$/i.exec(s);
  if (m) return `${m[1]}T${m[2]}Z`;
  return Number.isNaN(Date.parse(s)) || !/^\d{4}-\d{2}-\d{2}T/.test(s) ? null : s;
}

/** A positive amount from a number or a numeric string ("1000"), else null. */
function amount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const label = (code: unknown): string | null => str(code)?.replace(/_/g, ' ') ?? null;

/** The work arrangement, only when the offer states exactly one (an offer open to several states none). */
function workModelOf(o: Record<string, unknown>): string | null {
  if (o.hybrid === true) return 'hybrid';
  if (o.remote === true && o.on_site !== true) return 'remote';
  if (o.on_site === true && o.remote !== true) return 'on-site';
  return null;
}

export function mapRecruiteeOffer(raw: unknown, source: BoardSource, now: Date): ProviderJobInput | null {
  const o = obj(raw);
  const id = o && (num(o.id) ?? str(o.id));
  const title = o && str(o.title);
  if (!o || id === null || id === undefined || !title) return null;
  // The Careers Site API lists published offers; an offer that says otherwise is not one.
  const status = str(o.status);
  if (status && status.toLowerCase() !== 'published') return null;
  const places = arr(o.locations)
    .map(obj)
    .filter((l): l is Record<string, unknown> => !!l);
  const first = places[0] ?? null;
  const placeOf = (l: Record<string, unknown>): string | null => uniqueStrings([l.city, l.state, l.country]).join(', ') || null;
  const location = (first ? placeOf(first) : null) ?? str(o.location) ?? (uniqueStrings([o.city, o.country]).join(', ') || null);
  const slug = str(o.slug);
  const page = httpsUrl(o.careers_url) ?? (slug ? `https://${source.boardToken}.recruitee.com/o/${enc(slug)}` : null);
  const salary = obj(o.salary);
  const min = salary ? amount(salary.min) : null;
  const max = salary ? amount(salary.max) : null;
  const published = recruiteeTime(o.published_at);
  const closes = recruiteeTime(o.close_at);
  // The payload separates the text into two HTML parts; they are one posting.
  const html = [str(o.description), str(o.requirements)].filter(Boolean).join('');
  return {
    ...base(source, id, now),
    title,
    applyUrl: page,
    sourceUrl: page,
    location,
    locations: uniqueStrings([location, ...places.map(placeOf)]),
    locationCity: (first ? str(first.city) : null) ?? str(o.city),
    locationRegion: first ? str(first.state) : null,
    ...countryFields(isoCountry(first?.country_code) ?? isoCountry(first?.country) ?? isoCountry(o.country_code) ?? isoCountry(o.country), source),
    workModel: workModelOf(o),
    employmentType: label(o.employment_type_code),
    seniority: label(o.experience_code),
    // Pay only when the offer states an amount.
    ...(min !== null || max !== null ? { salaryMin: min, salaryMax: max, salaryCurrency: str(salary!.currency), salaryPeriod: str(salary!.period) } : {}),
    descriptionHtml: html || null,
    postedAt: published,
    postedAtEstimated: !published,
    ...(closes ? { expiresAt: closes } : {}),
  };
}

export const recruitee: AtsConnector = {
  ats: 'recruitee',
  boardUrl: (token) => `https://${token}.recruitee.com/api/offers/`,
  async read(source, deps, opts = {}) {
    const body = obj(await getJson(this.boardUrl(source.boardToken), deps));
    if (!body || !Array.isArray(body.offers)) throw new BoardFetchError('unexpected_shape');
    // Every offer carries the company name the board states.
    const boardCompanyName = body.offers.map((o) => str(obj(o)?.company_name)).find((n) => !!n) ?? null;
    const as = named(source, boardCompanyName);
    const listing = body.offers.map((raw) => mapRecruiteeOffer(raw, as, deps.now)).filter((x): x is ProviderJobInput => !!x);
    return wholeBoard(listing, opts, 1, boardCompanyName);
  },
};
