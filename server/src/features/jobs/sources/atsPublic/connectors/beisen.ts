// server/src/features/jobs/sources/atsPublic/connectors/beisen.ts — 北森 tenant
// boards, `<tenant>.zhiye.com` (MKT-5B, JC-8; MARKET_STRATEGY 1.4 tier 2 and 7
// item 14; JOB_SOURCES_CN 4.4, 5.1, 6 tier 2, 8; docs/job-search/ATS_BOARDS.md).
//
// OFF BY DEFAULT. This connector is built only while CN_ATS_BEISEN_ENABLED is
// true (../connectors.ts `connectorFor`), and ../http.ts knows the host only
// then. The flag waits for counsel's memo on reading employer boards in the
// mainland (反不正当竞争法 2025, Art. 13(3)). Nothing in this repository has
// ever called a 北森 board: the wire shape below is NOT VERIFIED BY US.
//
// Where the shape comes from. The research note cites one source for it, the
// connector of the open-source OpenHire project (MIT licence;
// github.com/gzchenhao/openhire, src/openhire/ats/beisen.py and
// tests/test_beisen.py, read 2026-10-12). From it, as facts about the wire:
//
//   POST https://{tenant}.zhiye.com/api/Jobad/GetJobAdPageList      (JSON body)
//     PageIndex      0, 1, 2 …
//     PageSize       50
//     Category       ["1"] = 社招 (the value for 校招 is not stated there)
//     KeyWords "", SpecialType 0, PortalId ""
//     DisplayFields  the portal sends these fields only when asked for them
//   answer  { Data: [ … ], Count: <total> }
//     Id (a GUID; the posting page is addressed by it), JobAdName, Duty,
//     Require, LocNames[], Salary (text), PostDateInt (epoch ms; 0 = none),
//     PostDate ("YYYY-MM-DDTHH:mm:ss", Beijing time; "0001-01-01T00:00:00" =
//     none). (`Kind` is sent too; this connector does not read it.)
//   posting page  https://{tenant}.zhiye.com/social/detail?jobAdId={Id}
//
// Before the flag is ever turned on, ops must record one real response and
// re-verify this mapper against it (__fixtures__/README.md). The committed
// fixture is SYNTHETIC.
//
// Rules this file enforces (the rest are in ingest/boards.ts):
//   - no cookie, token, signature or Referer is sent, and none is computed;
//     an answer that is not the listing (a login page, a captcha, an error
//     object) fails the read as a hard failure ('not_json', 'unexpected_shape',
//     'redirect', 'http_401' …): it is never worked around;
//   - at most `maxPostings` postings per tenant and run
//     (CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN, default 200). A listing cut by the
//     cap is incomplete, so nothing is closed for being beyond it;
//   - pages of one tenant are asked one after the other;
//   - a tenant on CN_ATS_TENANT_DENYLIST is never asked;
//   - market cn only. A tenant board is a mainland employer's board, so a
//     posting is in mainland China unless it says otherwise: every posting is
//     handed on with the country CN as its stated country. A place name is
//     taken out only on positive evidence that it is elsewhere: the name
//     itself resolves to another country (Hong Kong, Macau and Taiwan
//     included), or it says "abroad" (海外, 境外, 国外). A name the place table
//     does not know (昆山, 义乌, 全国) is no such evidence and stays. A posting
//     whose every place is elsewhere is dropped and counted
//     (`droppedPostings`); one with places on both sides keeps its mainland
//     places only. What is handed on is then checked against the router
//     itself (../market.ts `routePosting`): anything it would not write as one
//     mainland row is dropped and counted too, so no copy for the
//     international market can come out of a tenant board;
//   - a listing is complete only when we hold as many DISTINCT postings as
//     the board says it lists (`Count`). A portal that repeats rows from page
//     to page, or counts from another page index than we do, is then
//     incomplete and closes nothing;
//   - only the fields listed above are read. `WorkWeChatQrCode` is not asked
//     for and is never copied; no phone, WeChat id or e-mail field is read;
//     and a recruiter's phone number or WeChat id written into the posting
//     text is taken out before the input is built (the same rule the mainland
//     ingest hook applies again);
//   - pay as posted: the `Salary` text goes on verbatim. A bare pair such as
//     "35-57" is kept as words and is never an amount to filter on (the
//     normalizer's mainland rule);
//   - a zone-less time is Beijing time and year 0001 is "no date" (the
//     normalizer's rules for market cn; here the 0001 marker is dropped).
//
// Hire type. `BEISEN_PASSES` holds the one category the source confirms
// (社招). A 校招 pass is one more entry once its Category value and page path
// are read from a real board; it is not guessed.

import { parseLocation } from '../../../geo/index.js';
import type { ProviderJobInput } from '../../../normalize/index.js';
import { TENANT_LABEL_PATTERN } from '../contract.js';
import { BoardFetchError, postJson } from '../http.js';
import { routePosting } from '../market.js';
import { arr, num, obj, str } from '../shared.js';
import { base, byExternalId, enc, uniqueStrings, type AtsConnector, type BoardRead, type BoardSource } from './common.js';

/** One listing pass: a recruitment category of the board and the path of its posting pages. */
export interface BeisenPass {
  /** The portal's `Category` value. */
  category: string;
  /** 社招 or 校招, from the category that listed the posting. */
  hire: 'social' | 'campus';
  /** The path of a posting's page on the tenant board. */
  pagePath: string;
}

/** The passes read by default: 社招 only (see the header). */
export const BEISEN_PASSES: readonly BeisenPass[] = [{ category: '1', hire: 'social', pagePath: '/social/detail' }];

export const BEISEN_PAGE_SIZE = 50;
/** The fields the portal is asked to fill. The QR-code field is deliberately not among them. */
export const BEISEN_DISPLAY_FIELDS: readonly string[] = ['Category', 'Kind', 'LocId', 'PostDate', 'Salary'];
/** The only keys of a posting this connector reads (`mapBeisenPosting`). */
export const BEISEN_READ_KEYS: readonly string[] = ['Id', 'JobAdName', 'Duty', 'Require', 'LocNames', 'Salary', 'PostDateInt', 'PostDate'];
/** A read that is refused because the tenant is on the denylist. */
export const TENANT_DENIED = 'tenant_denied';

/** Takes recruiter phone numbers and WeChat ids out of a text (the mainland rule, cn/jobs `stripContactInfo`). */
export type ContactStrip = (text: string, options?: { html?: boolean }) => { text: string; removed: number };

export interface BeisenConnectorOptions {
  /** Hard cap of postings per tenant and run. */
  maxPostings: number;
  /** Tenant board ids that are never asked (lower case). */
  denylist?: readonly string[];
  passes?: readonly BeisenPass[];
  /** Test seam; default: the mainland rule, loaded when a board is read. */
  strip?: ContactStrip;
}

export function beisenListUrl(tenant: string): string {
  return `https://${tenant}.zhiye.com/api/Jobad/GetJobAdPageList`;
}

export function beisenPostingUrl(tenant: string, pass: Pick<BeisenPass, 'pagePath'>, id: string): string {
  return `https://${tenant}.zhiye.com${pass.pagePath}?jobAdId=${enc(id)}`;
}

/** The request body of one page of one pass (see the header for where each key comes from). */
export function beisenRequestBody(pass: Pick<BeisenPass, 'category'>, pageIndex: number): Record<string, unknown> {
  return { PageIndex: pageIndex, PageSize: BEISEN_PAGE_SIZE, Category: [pass.category], KeyWords: '', SpecialType: 0, PortalId: '', DisplayFields: [...BEISEN_DISPLAY_FIELDS] };
}

/** The posting date as the board states it: the epoch field when set, else the zone-less text unless it is the "no date" marker. */
function postedAt(j: Record<string, unknown>): string | null {
  const ms = num(j.PostDateInt);
  if (ms !== null && ms > 0) {
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2000) return d.toISOString();
  }
  const text = str(j.PostDate);
  // Year 0001 is how the board writes "no date".
  return text && !/^0001-/.test(text) ? text : null;
}

/** Words that say "outside the country" without naming one. */
const ABROAD_WORDS = /海外|境外|国外|國外/;

/**
 * Is this place name positively outside mainland China? Only on evidence (see
 * the header): the name by itself resolves to another country (the place
 * table files Hong Kong, Macau and Taiwan as their own), or it says "abroad".
 * A name the table does not know is not evidence.
 */
export function isOutsideMainland(name: string): boolean {
  if (ABROAD_WORDS.test(name)) return true;
  const country = parseLocation(name).country;
  return !!country && country !== 'CN';
}

export interface MappedBeisenPosting {
  input: ProviderJobInput;
  /** The posting names places and every one of them is outside mainland China. */
  outside: boolean;
}

export function mapBeisenPosting(raw: unknown, source: BoardSource, now: Date, pass: BeisenPass, strip: ContactStrip): MappedBeisenPosting | null {
  const j = obj(raw);
  const id = j && str(j.Id);
  const title = j && str(j.JobAdName);
  if (!j || !id || !title) return null;
  const named = uniqueStrings(arr(j.LocNames));
  // Only the places in mainland China are handed on (a posting that names none at all is the employer's own, at home).
  const places = named.filter((name) => !isOutsideMainland(name));
  const page = beisenPostingUrl(source.boardToken, pass, id);
  // The two text fields are one posting; contact details a recruiter typed into them never leave this function.
  const html = [str(j.Duty), str(j.Require)].filter(Boolean).join('<br><br>');
  const posted = postedAt(j);
  const salary = str(j.Salary);
  const input: ProviderJobInput = {
    ...base(source, id, now),
    title: strip(title).text,
    applyUrl: page,
    sourceUrl: page,
    location: places[0] ?? null,
    locations: places,
    // A mainland employer's tenant board: the country is stated, so a city the place table does not know
    // (昆山, 义乌) and a posting for the whole country (全国) are still read in China.
    locationCountry: 'CN',
    locationCountryEstimated: false,
    // Pay exactly as posted; never a figure of ours.
    salaryText: salary ? strip(salary).text : null,
    descriptionHtml: html ? strip(html, { html: true }).text : null,
    postedAt: posted,
    postedAtEstimated: !posted,
  };
  return { input, outside: named.length > 0 && places.length === 0 };
}

interface PassRead {
  rows: unknown[];
  calls: number;
  /** The board's own total for the pass, when it states one. */
  total: number | null;
  /** Distinct postings among `rows` (a portal may send a row twice). */
  distinct: number;
  /** False when the pass stopped before the end of its listing (the cap, the page limit of a check), or holds fewer distinct postings than the board says it lists. */
  complete: boolean;
}

/** Distinct postings among `rows`, by `Id`; a row without one counts for itself. */
function distinctPostings(rows: readonly unknown[]): number {
  const ids = new Set<string>();
  let nameless = 0;
  for (const raw of rows) {
    const id = str(obj(raw)?.Id);
    if (id) ids.add(id);
    else nameless += 1;
  }
  return ids.size + nameless;
}

async function defaultStrip(): Promise<ContactStrip> {
  return (await import('../../../../cn/jobs/index.js')).stripContactInfo;
}

export function createBeisenConnector(options: BeisenConnectorOptions): AtsConnector {
  const passes = options.passes ?? BEISEN_PASSES;
  const cap = Math.max(1, Math.floor(options.maxPostings));
  const denied = new Set((options.denylist ?? []).map((t) => t.trim().toLowerCase()));

  /** One pass, page after page, until its end, `room` postings or `maxPages` pages. */
  async function listPass(tenant: string, pass: BeisenPass, deps: Parameters<AtsConnector['read']>[1], room: number, maxPages: number): Promise<PassRead> {
    const rows: unknown[] = [];
    let calls = 0;
    let total: number | null = null;
    for (let page = 0; page < maxPages && rows.length < room; page += 1) {
      const body = obj(await postJson(beisenListUrl(tenant), beisenRequestBody(pass, page), deps));
      calls += 1;
      // Anything but the listing (an error object, a sign-in prompt) is not worked around.
      if (!body || !Array.isArray(body.Data)) throw new BoardFetchError('unexpected_shape');
      if (page === 0) total = num(body.Count);
      rows.push(...body.Data.slice(0, room - rows.length));
      const seen = page * BEISEN_PAGE_SIZE + body.Data.length;
      if (body.Data.length < BEISEN_PAGE_SIZE || (total !== null && seen >= total)) {
        // The end of the listing by the page arithmetic. That is only "complete" when nothing was cut by the cap
        // and the rows are as many DISTINCT postings as the board states (without a stated total: no row twice).
        const distinct = distinctPostings(rows);
        return { rows, calls, total, distinct, complete: rows.length === seen && distinct === (total ?? rows.length) };
      }
    }
    return { rows, calls, total, distinct: distinctPostings(rows), complete: false };
  }

  return {
    ats: 'beisen',
    boardUrl: beisenListUrl,
    async read(source, deps, opts = {}): Promise<BoardRead> {
      const tenant = source.boardToken;
      // The id becomes a host name: one lower-case label, or no request at all.
      if (!TENANT_LABEL_PATTERN.test(tenant)) throw new BoardFetchError('invalid_board_id');
      if (denied.has(tenant)) throw new BoardFetchError(TENANT_DENIED);
      const strip = options.strip ?? (await defaultStrip());
      const firstPageOnly = opts.listOnly === true && opts.firstPage === true;
      const listing: ProviderJobInput[] = [];
      const listed = new Set<string>();
      let calls = 0;
      let complete = true;
      let stated = 0;
      let dropped = 0;
      let taken = 0;
      for (const pass of firstPageOnly ? passes.slice(0, 1) : passes) {
        const room = cap - taken;
        if (room <= 0) {
          // The cap is used up before this pass was asked: the listing is cut short.
          complete = false;
          break;
        }
        const read = await listPass(tenant, pass, deps, room, firstPageOnly ? 1 : Math.ceil(cap / BEISEN_PAGE_SIZE));
        calls += read.calls;
        taken += read.rows.length;
        complete &&= read.complete;
        stated += Math.max(read.total ?? 0, read.distinct);
        for (const raw of read.rows) {
          const mapped = mapBeisenPosting(raw, source, deps.now, pass, strip);
          if (!mapped) continue;
          // Market cn only (see the header): a posting located elsewhere is not this source's to list, and neither
          // is one the router would not write as exactly one mainland row.
          const copies = mapped.outside ? [] : routePosting(mapped.input);
          if (copies.length !== 1 || copies[0]!.market !== 'cn') dropped += 1;
          else if (!listed.has(mapped.input.externalId)) {
            listed.add(mapped.input.externalId);
            listing.push(mapped.input);
          }
        }
      }
      // A listing read to its end is counted; one cut short states the board's own total.
      const listedCount = complete ? listing.length : Math.max(stated - dropped, listing.length);
      return {
        inputs: opts.listOnly ? [] : listing,
        listing,
        listedIds: listing.map(byExternalId),
        listedCount,
        complete,
        calls,
        pendingDetails: 0,
        failedDetails: 0,
        // The listing states no company name for the board.
        boardCompanyName: null,
        droppedPostings: dropped,
      };
    },
  };
}
