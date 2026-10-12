// server/src/features/jobs/sources/atsPublic/connectors.ts — public ATS job-board
// connectors (TASK_PLAN.md WP-42; CN_TW_LAUNCH_PLAN.md WP-TW-JOBS; MKT-5B).
//
// Each connector reads the endpoint the ATS publishes for embedding a job
// board and maps every posting to the normalizer's input (provider
// 'ats_public', sourceBoard = the ATS name):
//
//   greenhouse       GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true&pay_transparency=true
//   lever            GET api.lever.co/v0/postings/{site}?mode=json&skip&limit
//   lever_eu         the same on api.eu.lever.co (Lever's EU instance; rows keep the board name 'lever_eu')
//   ashby            GET api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
//   smartrecruiters  GET api.smartrecruiters.com/v1/companies/{id}/postings (+ /postings/{id} for the text)
//   workable         ./connectors/workable.ts   (kill switch ATS_WORKABLE_DISABLED)
//   recruitee        ./connectors/recruitee.ts
//   personio         ./connectors/personio.ts
//   beisen           ./connectors/beisen.ts     (exists only while CN_ATS_BEISEN_ENABLED is true)
//
// Workday is not supported: it publishes no public postings API, and its
// career sites are not read (no scraping, ever — L-5).
//
// D3: fields are passed through as the board states them. Pay is a figure
// only when the board gives one; otherwise the normalizer reads the posting
// text (TW-03: 面議 / 依公司規定 stay "not disclosed", verbatim). The
// board's country tag is only a weak hint for an ambiguous city, never the
// job's country.
//
// Market and countries (MARKET_STRATEGY JC-4, JI-3, JI-4). A connector does
// not decide a posting's market: it returns the whole listing and ./market.ts
// routes every posting by its own location. What a connector does know is how
// its API is asked:
//   - Greenhouse and Ashby list a whole board in ONE call, with the posting
//     texts, so every listed posting is handed on (no size cap);
//   - Lever pages with skip / limit to the end (safety stop at LEVER_MAX_PAGES
//     pages, which marks the listing incomplete);
//   - SmartRecruiters lists without the texts. The listing is ALWAYS read
//     completely, once per country in the source's `countries` (the API's own
//     `country` filter) or once without a filter when the list is empty, so
//     the closure diff is exact. A posting's text is one more request each:
//     only postings we have not stored yet are read (up to `detailsBudget`
//     per run, the rest on later runs: `pendingDetails`), and what is left of
//     the budget refreshes the rows saved longest ago. A text request that
//     fails skips that posting for the run (`failedDetails` counts the new
//     postings among them); once one is answered 429 no further text is asked
//     for in that run. `storedIds` tells the connector under which
//     externalIds this deployment stores a posting (none = not wanted here:
//     its text is never requested).
//
// Greenhouse, read in two steps (requests/waveM4-carryover.md, MKT-5B.7). A
// board's answer with its texts is large (megabytes), and most reads find
// nothing new. So when we already hold postings of the board, the listing is
// first asked WITHOUT the texts (`…/jobs`). That answer is a list of posting
// ids and little else: id, title, `location.name`, `updated_at`,
// `first_published`, `application_deadline`. It carries NO `offices`, no
// `departments` and no `content` (seen on a live board on 2026-10-12, and what
// the documentation says `content=true` adds), so it cannot say where a
// posting is and is never routed to a market. It is compared with our rows by
// posting id only (a posting is stored as `<board>:<id>`, and as
// `<board>:<id>#cn` for its mainland copy):
//   - a listed posting we hold no open row of, under either id, needs the
//     texts (unless its stated deadline has passed: it is not kept open);
//   - so does one whose `updated_at` is later than our oldest copy of it,
//     less a 30-minute margin for the time between a read and its write (an
//     edit is also how a posting gains or loses a location);
//   - when no posting needs them, nothing is downloaded and nothing is
//     rewritten: the read is `unchangedById`, and the board sync marks the
//     rows of the listed postings as seen and closes the rows of postings the
//     board no longer lists (./sync.ts).
// Any posting that needs its text makes the second request, the whole read,
// which is routed and written like every other board's. The first step is
// taken only where "listed, and we hold no row of it" means "new": the source
// is read for every country and this deployment writes both markets
// (`storesEveryPosting`). A board read for some countries only, and every
// board on a deployment that writes one market, is read whole as before.
// Once a week, at a time that depends on the board id (so the boards do not
// all fall on one hour), the first read is a whole read whatever the listing
// says: a change in how we read a posting, or an edit that did not move
// `updated_at`, then reaches every stored row within seven days. A board we
// hold nothing of, and a source still without its company name, are read
// whole at once.
//
// Greenhouse pay and deadline (JI-8). The list call is asked with
// `pay_transparency=true`: a posting that carries `pay_input_ranges` gives its
// first range with numeric bounds as pay (the API states cents), and a stated
// `application_deadline` is passed on as the posting's expiry (binding for a
// board row: normalize/identity.ts `resolveExpiresAt`). A board that sends
// neither is mapped exactly as before, and no request is ever made per
// posting. (The key was seen on the list call of two live boards on
// 2026-10-12, empty on every posting; a populated range has the shape of the
// documented sample.)
//
// `listOnly` (admin "Check now", candidate validation) reads the listing and
// nothing else. With `firstPage` it asks SmartRecruiters for ONE page per
// country pass and takes the number of postings from the board's own total:
// what a check needs (does it answer, how many does it list, which company)
// is on the first page, and paging a large board to its end would be up to
// 200 requests. `boardCompany` also asks the board for the company name it
// states (Greenhouse: one more documented request; SmartRecruiters: already in
// the listing; Lever and Ashby state none).
//
// Which connectors exist (`connectorEnabled`, `connectorFor`). A system whose
// connector is switched off cannot be read by any caller: `connectorFor`
// throws 'connector_disabled' before a URL is built. Workable is on unless
// ATS_WORKABLE_DISABLED is true; 北森 is off unless CN_ATS_BEISEN_ENABLED is
// true (and then ./http.ts also knows its host).

import type { EnvSource } from '../../../../platform/brand/index.js';
import type { ProviderJobInput } from '../../normalize/index.js';
import { CONNECTOR_DISABLED, PUBLIC_ATS, type BoardAts } from './contract.js';
import { createBeisenConnector } from './connectors/beisen.js';
import {
  base,
  byExternalId,
  countryFields,
  dateFromMs,
  enc,
  hasPlaceholderName,
  isoCountry,
  named,
  uniqueStrings,
  wholeBoard,
  type AtsConnector,
  type BoardRead,
  type BoardSource,
  type ConnectorDeps,
} from './connectors/common.js';
import { personio } from './connectors/personio.js';
import { recruitee } from './connectors/recruitee.js';
import { workable } from './connectors/workable.js';
import { BoardFetchError, getJson } from './http.js';
import { copyIdsOf } from './market.js';
import { arr, beisenEnabled, beisenMaxPostingsPerRun, decodeEntities, LEVER_MAX_PAGES, normalizeCountries, num, obj, SMARTRECRUITERS_MAX_PAGES, str, tenantDenylist, workableEnabled } from './shared.js';

export { hasPlaceholderName } from './connectors/common.js';
export type { AtsConnector, BoardRead, BoardSource, ConnectorDeps, ReadOptions } from './connectors/common.js';

/**
 * The first `limit` of `items`: postings not in `known` first (listing order),
 * then known ones refreshed longest ago (never-refreshed first). Postings left
 * out this run are refreshed least recently, so they come first next run.
 */
export function prioritise<T>(items: readonly T[], idOf: (item: T) => string, known: ReadonlyMap<string, Date | null> | undefined, limit: number): T[] {
  // Under the cap every posting is read: keep the listing order.
  if (items.length <= limit) return items.slice();
  const fresh: T[] = [];
  const seen: { item: T; at: number; order: number }[] = [];
  items.forEach((item, order) => {
    const id = idOf(item);
    if (!known?.has(id)) fresh.push(item);
    else seen.push({ item, at: known.get(id)?.getTime() ?? Number.NEGATIVE_INFINITY, order });
  });
  seen.sort((a, b) => a.at - b.at || a.order - b.order);
  return [...fresh, ...seen.map((x) => x.item)].slice(0, Math.max(0, limit));
}

// ── Greenhouse ────────────────────────────────────────────────────────────

/** One entry of Greenhouse's `pay_input_ranges` (docs.greenhouse.io/job-board.html, "Retrieve a job": min_cents, max_cents, currency_type, title, blurb). */
function greenhousePay(raw: unknown): Pick<ProviderJobInput, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryText'> {
  for (const entry of arr(raw)) {
    const range = obj(entry);
    const min = range ? num(range.min_cents) : null;
    const max = range ? num(range.max_cents) : null;
    // The first range with a numeric bound; a bound of 0 or less is no figure.
    if (!range || ((min === null || min <= 0) && (max === null || max <= 0))) continue;
    return {
      salaryMin: min !== null && min > 0 ? min / 100 : null,
      salaryMax: max !== null && max > 0 ? max / 100 : null,
      salaryCurrency: str(range.currency_type),
      // The range's own title ("NYC Salary Range") is the pay text; the blurb is prose and stays out.
      salaryText: str(range.title),
    };
  }
  return {};
}

export function mapGreenhouseJob(raw: unknown, source: BoardSource, now: Date): ProviderJobInput | null {
  const j = obj(raw);
  const id = j && (num(j.id) ?? str(j.id));
  const title = j && str(j.title);
  if (!j || id === null || !title) return null;
  const url = str(j.absolute_url);
  const location = str(obj(j.location)?.name);
  const offices = arr(j.offices).map((o) => obj(o)?.location ?? obj(o)?.name);
  const content = str(j.content);
  const deadline = str(j.application_deadline);
  return {
    ...base(source, id, now),
    title,
    applyUrl: url,
    sourceUrl: url,
    location,
    locations: uniqueStrings([location, ...offices]),
    ...countryFields(null, source),
    descriptionHtml: content ? decodeEntities(content) : null,
    // first_published is the posting date; updated_at is not (any edit moves it).
    postedAt: str(j.first_published),
    postedAtEstimated: !str(j.first_published),
    // Pay only when the board sends a range (the description is still read for a pay line otherwise).
    ...greenhousePay(j.pay_input_ranges),
    // A stated application deadline is the posting's expiry; none stated adds nothing.
    ...(deadline ? { expiresAt: deadline } : {}),
  };
}

/** The company name a Greenhouse board states (GET /v1/boards/{token}); null when it cannot be read. */
async function greenhouseBoardName(boardToken: string, deps: ConnectorDeps): Promise<string | null> {
  try {
    return str(obj(await getJson(`https://boards-api.greenhouse.io/v1/boards/${enc(boardToken)}`, deps))?.name);
  } catch {
    return null;
  }
}

/** The listing with the posting texts and, where the board states them, the pay ranges (see the header). */
export function greenhouseReadUrl(boardToken: string): string {
  return `${greenhouse.boardUrl(boardToken)}&pay_transparency=true`;
}

/** The listing without the posting texts (a check by hand, a candidate, and the first step of a read). */
export function greenhouseListUrl(boardToken: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${enc(boardToken)}/jobs`;
}

/** A posting edited this long before we last saved it is read again: the time between a read and its write is inside it. */
export const GREENHOUSE_CHANGE_MARGIN_MS = 30 * 60 * 1000;
/** Every board is read whole at least this often, whatever its listing says (see the header). */
export const GREENHOUSE_FULL_READ_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** A stable number from a board id, used to spread the boards' weekly whole reads over the week. */
function tokenOffsetMs(boardToken: string): number {
  let h = 0;
  for (let i = 0; i < boardToken.length; i += 1) h = (h * 31 + boardToken.charCodeAt(i)) >>> 0;
  return h % GREENHOUSE_FULL_READ_EVERY_MS;
}

/**
 * Is this the board's first read of its week? `known` holds when each stored
 * posting was last saved or marked as seen; the latest of those is when the
 * board was last read. The week starts at an hour of its own for every board.
 */
export function greenhouseFullReadDue(boardToken: string, now: Date, known: ReadonlyMap<string, Date | null>): boolean {
  let last = Number.NEGATIVE_INFINITY;
  for (const at of known.values()) if (at && at.getTime() > last) last = at.getTime();
  if (!Number.isFinite(last)) return true;
  const week = (ms: number): number => Math.floor((ms - tokenOffsetMs(boardToken)) / GREENHOUSE_FULL_READ_EVERY_MS);
  return week(now.getTime()) !== week(last);
}

/**
 * Does a listed posting need its text read? Decided from the listing without
 * texts and our open rows alone, by posting id (see the header): we hold no
 * row of it, or it was edited since our oldest copy. Never from where the
 * posting is: that listing does not say.
 */
export function greenhouseNeedsText(raw: unknown, listed: Pick<ProviderJobInput, 'externalId' | 'expiresAt'>, now: Date, known: ReadonlyMap<string, Date | null>): boolean {
  const held = copyIdsOf(listed.externalId).filter((id) => known.has(id));
  if (held.length === 0) {
    // A posting whose stated deadline has passed is not kept open, so it is never "new" again.
    const deadline = typeof listed.expiresAt === 'string' ? Date.parse(listed.expiresAt) : Number.NaN;
    return !(Number.isFinite(deadline) && deadline < now.getTime());
  }
  const edited = Date.parse(str(obj(raw)?.updated_at) ?? '');
  const saved = Math.min(...held.map((id) => known.get(id)?.getTime() ?? Number.NEGATIVE_INFINITY));
  // An edit time or a save time we cannot read is a posting we cannot vouch for.
  if (!Number.isFinite(edited) || !Number.isFinite(saved)) return true;
  return edited > saved - GREENHOUSE_CHANGE_MARGIN_MS;
}

export const greenhouse: AtsConnector = {
  ats: 'greenhouse',
  boardUrl: (token) => `https://boards-api.greenhouse.io/v1/boards/${enc(token)}/jobs?content=true`,
  async read(source, deps, opts = {}) {
    let calls = 0;
    // Step 1 (see the header): we hold postings of this board and keep every one of them, so ask which
    // postings it lists, and when each was edited, before asking for the texts.
    if (!opts.listOnly && opts.storesEveryPosting === true && opts.known && opts.known.size > 0 && !hasPlaceholderName(source) && !greenhouseFullReadDue(source.boardToken, deps.now, opts.known)) {
      const light = obj(await getJson(greenhouseListUrl(source.boardToken), deps));
      if (!light || !Array.isArray(light.jobs)) throw new BoardFetchError('unexpected_shape');
      calls += 1;
      const known = opts.known;
      const entries = light.jobs
        .map((raw) => ({ raw, listed: mapGreenhouseJob(raw, source, deps.now) }))
        .filter((e): e is { raw: unknown; listed: ProviderJobInput } => !!e.listed);
      if (!entries.some((e) => greenhouseNeedsText(e.raw, e.listed, deps.now, known))) {
        // Nothing to read. This listing names the postings and does not place them: it is handed on as ids only.
        return { ...wholeBoard(entries.map((e) => e.listed), { listOnly: true }, calls, null), unchangedById: true };
      }
    }
    // listOnly: the same listing without the posting texts.
    const url = opts.listOnly ? greenhouseListUrl(source.boardToken) : greenhouseReadUrl(source.boardToken);
    const body = obj(await getJson(url, deps));
    if (!body || !Array.isArray(body.jobs)) throw new BoardFetchError('unexpected_shape');
    calls += 1;
    let boardCompanyName: string | null = null;
    if (opts.boardCompany || hasPlaceholderName(source)) {
      boardCompanyName = await greenhouseBoardName(source.boardToken, deps);
      calls += 1;
    }
    const as = named(source, boardCompanyName);
    // The whole board comes in one answer: every listed posting is handed on.
    const listing = body.jobs.map((raw) => mapGreenhouseJob(raw, as, deps.now)).filter((x): x is ProviderJobInput => !!x);
    return wholeBoard(listing, opts, calls, boardCompanyName);
  },
};

// ── Lever ─────────────────────────────────────────────────────────────────

const LEVER_PAGE = 100;

export function mapLeverPosting(raw: unknown, source: BoardSource, now: Date): ProviderJobInput | null {
  const j = obj(raw);
  const id = j && str(j.id);
  const title = j && str(j.text);
  if (!j || !id || !title) return null;
  const cat = obj(j.categories) ?? {};
  const location = str(cat.location);
  const lists = arr(j.lists)
    .map((l) => {
      const item = obj(l);
      const heading = item && str(item.text);
      const content = item && str(item.content);
      return content ? `${heading ? `<h3>${heading}</h3>` : ''}<ul>${content}</ul>` : '';
    })
    .join('');
  const html = [str(j.description), lists, str(j.additional)].filter(Boolean).join('');
  const salary = obj(j.salaryRange);
  const hosted = str(j.hostedUrl);
  return {
    ...base(source, id, now),
    title,
    applyUrl: str(j.applyUrl) ?? hosted,
    sourceUrl: hosted,
    location,
    locations: uniqueStrings([location, ...arr(cat.allLocations)]),
    ...countryFields(isoCountry(j.country), source),
    workModel: str(j.workplaceType) === 'unspecified' ? null : str(j.workplaceType),
    employmentType: str(cat.commitment),
    salaryMin: salary ? num(salary.min) : null,
    salaryMax: salary ? num(salary.max) : null,
    salaryCurrency: salary ? str(salary.currency) : null,
    salaryPeriod: salary ? str(salary.interval) : null,
    salaryText: str(j.salaryDescriptionPlain),
    descriptionHtml: html || null,
    description: str(j.descriptionPlain),
    postedAt: dateFromMs(j.createdAt),
    postedAtEstimated: dateFromMs(j.createdAt) === null,
  };
}

/**
 * A Lever connector for one of Lever's two instances. They are separate
 * systems with the same API: a site name and a posting id on one say nothing
 * about the other, so the EU instance has its own system id (`lever_eu`) and
 * its rows their own board name. The posting links are the API's own
 * (`hostedUrl`, `applyUrl`: jobs.lever.co / jobs.eu.lever.co).
 */
export function createLeverConnector(ats: 'lever' | 'lever_eu', apiHost: 'api.lever.co' | 'api.eu.lever.co'): AtsConnector {
  return {
    ats,
    boardUrl: (token) => `https://${apiHost}/v0/postings/${enc(token)}?mode=json`,
    async read(source, deps, opts = {}) {
      const listing: ProviderJobInput[] = [];
      let calls = 0;
      let complete = false;
      // Page to the end; the safety stop marks the listing incomplete (closures are then skipped).
      for (let page = 0; page < LEVER_MAX_PAGES; page += 1) {
        const body = await getJson(`${this.boardUrl(source.boardToken)}&skip=${page * LEVER_PAGE}&limit=${LEVER_PAGE}`, deps);
        calls += 1;
        if (!Array.isArray(body)) throw new BoardFetchError('unexpected_shape');
        for (const raw of body) {
          const input = mapLeverPosting(raw, source, deps.now);
          if (input) listing.push(input);
        }
        if (body.length < LEVER_PAGE) {
          complete = true;
          break;
        }
      }
      // Lever states no company name for a board.
      return { ...wholeBoard(listing, opts, calls, null), complete };
    },
  };
}

export const lever: AtsConnector = createLeverConnector('lever', 'api.lever.co');
export const leverEu: AtsConnector = createLeverConnector('lever_eu', 'api.eu.lever.co');

// ── Ashby ─────────────────────────────────────────────────────────────────

export function mapAshbyJob(raw: unknown, source: BoardSource, now: Date): ProviderJobInput | null {
  const j = obj(raw);
  const id = j && str(j.id);
  const title = j && str(j.title);
  if (!j || !id || !title || j.isListed === false) return null;
  const location = str(j.location);
  const secondary = arr(j.secondaryLocations).map((l) => obj(l)?.location);
  const postal = obj(obj(j.address)?.postalAddress);
  const comp = obj(j.compensation);
  const showPay = j.shouldDisplayCompensationOnJobPostings !== false;
  const salary = showPay
    ? arr(comp?.summaryComponents)
        .map(obj)
        .find((c) => c && str(c.compensationType)?.toLowerCase() === 'salary')
    : null;
  const workplace = str(j.workplaceType) ?? (j.isRemote === true ? 'remote' : null);
  const jobUrl = str(j.jobUrl);
  return {
    ...base(source, id, now),
    title,
    applyUrl: str(j.applyUrl) ?? jobUrl,
    sourceUrl: jobUrl,
    location,
    locations: uniqueStrings([location, ...secondary]),
    locationCity: postal ? str(postal.addressLocality) : null,
    locationRegion: postal ? str(postal.addressRegion) : null,
    ...countryFields(isoCountry(postal?.addressCountry), source),
    workModel: workplace,
    employmentType: str(j.employmentType),
    salaryMin: salary ? num(salary.minValue) : null,
    salaryMax: salary ? num(salary.maxValue) : null,
    salaryCurrency: salary ? str(salary.currencyCode) : null,
    salaryPeriod: salary ? str(salary.interval) : null,
    salaryText: showPay && comp ? str(comp.compensationTierSummary) : null,
    descriptionHtml: str(j.descriptionHtml),
    description: str(j.descriptionPlain),
    postedAt: str(j.publishedAt),
    postedAtEstimated: !str(j.publishedAt),
  };
}

export const ashby: AtsConnector = {
  ats: 'ashby',
  boardUrl: (token) => `https://api.ashbyhq.com/posting-api/job-board/${enc(token)}?includeCompensation=true`,
  async read(source, deps, opts = {}) {
    const body = obj(await getJson(this.boardUrl(source.boardToken), deps));
    if (!body || !Array.isArray(body.jobs)) throw new BoardFetchError('unexpected_shape');
    // One answer lists the whole board with its texts. Ashby states no company name for a board.
    const listing = body.jobs.map((raw) => mapAshbyJob(raw, source, deps.now)).filter((x): x is ProviderJobInput => !!x);
    return { inputs: opts.listOnly ? [] : listing, listing, listedIds: listing.map(byExternalId), listedCount: listing.length, complete: true, calls: 1, pendingDetails: 0, failedDetails: 0, boardCompanyName: null };
  },
};

// ── SmartRecruiters ───────────────────────────────────────────────────────

const SR_PAGE = 100;
/** Posting texts read per board and run (one request each). */
export const SR_MAX_DETAILS = 100;
const SR_CONCURRENCY = 4;
/**
 * Posting-text requests in flight on SmartRecruiters' API host across ALL
 * boards this process reads at once. The board sync reads several boards in
 * parallel (ATS_BOARDS_CONCURRENCY, up to 8), and every SmartRecruiters board
 * among them asks for up to 100 texts: without a cap of its own the host
 * would see boards x 4 requests at a time from one identifying User-Agent
 * (MARKET_STRATEGY §1.2 asks for 4 to 8 boards in flight, not 4 to 8 times
 * four requests on one host). A refusal costs a board an hour, so asking
 * politely is also the faster way through a large backlog.
 */
export const SR_HOST_CONCURRENCY = 4;

/** A counting gate: at most `limit` callers run at once; the others wait in order. A slot is handed straight to the next waiter. */
export function createHostGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

const smartRecruitersTextGate = createHostGate(SR_HOST_CONCURRENCY);

export function mapSmartRecruitersPosting(listRaw: unknown, detailRaw: unknown, source: BoardSource, now: Date): ProviderJobInput | null {
  const j = obj(listRaw);
  const id = j && str(j.id);
  const title = j && str(j.name);
  if (!j || !id || !title) return null;
  const d = obj(detailRaw) ?? {};
  const loc = obj(j.location) ?? obj(d.location) ?? {};
  const sections = obj(obj(d.jobAd)?.sections) ?? {};
  const html = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
    .map((k) => {
      const s = obj(sections[k]);
      const text = s && str(s.text);
      if (!text) return '';
      const heading = str(s.title);
      return `${heading ? `<h3>${heading}</h3>` : ''}${text}`;
    })
    .join('');
  const postingUrl = str(d.postingUrl) ?? `https://jobs.smartrecruiters.com/${enc(source.boardToken)}/${enc(id)}`;
  const workModel = loc.remote === true ? 'remote' : loc.hybrid === true ? 'hybrid' : null;
  return {
    ...base(source, id, now),
    title,
    applyUrl: str(d.applyUrl) ?? postingUrl,
    sourceUrl: postingUrl,
    location: str(loc.fullLocation) ?? ([str(loc.city), str(loc.region)].filter(Boolean).join(', ') || null),
    locationCity: str(loc.city),
    locationRegion: str(loc.region),
    ...countryFields(isoCountry(loc.country), source),
    workModel,
    employmentType: str(obj(j.typeOfEmployment)?.label),
    seniority: str(obj(j.experienceLevel)?.label),
    descriptionHtml: html || null,
    postedAt: str(j.releasedDate),
    postedAtEstimated: !str(j.releasedDate),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The SmartRecruiters listing URL of one page; `country` (ISO alpha-2) adds the API's own country filter. */
export function smartRecruitersListUrl(boardToken: string, offset: number, country?: string | null): string {
  const filter = country ? `&country=${enc(country.toLowerCase())}` : '';
  return `https://api.smartrecruiters.com/v1/companies/${enc(boardToken)}/postings?limit=${SR_PAGE}&offset=${offset}${filter}`;
}

interface SmartRecruitersPass {
  rows: Record<string, unknown>[];
  calls: number;
  /** False when the pass stopped before the end of the listing. */
  complete: boolean;
  /** The total the board states for this pass (`totalFound` of its first page), when it states one. */
  total: number | null;
}

/** One pass over the listing, optionally for one country: every page, or at most `maxPages`. */
async function listSmartRecruiters(boardToken: string, country: string | null, deps: ConnectorDeps, maxPages = SMARTRECRUITERS_MAX_PAGES): Promise<SmartRecruitersPass> {
  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  let stated: number | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * SR_PAGE;
    const body = obj(await getJson(smartRecruitersListUrl(boardToken, offset, country), deps));
    calls += 1;
    if (!body || !Array.isArray(body.content)) throw new BoardFetchError('unexpected_shape');
    for (const raw of body.content) {
      const row = obj(raw);
      if (row && str(row.id) && str(row.name)) rows.push(row);
    }
    const total = num(body.totalFound);
    if (page === 0) stated = total;
    if (body.content.length < SR_PAGE || (total !== null && offset + SR_PAGE >= total)) return { rows, calls, complete: true, total: stated };
  }
  return { rows, calls, complete: false, total: stated };
}

export const smartrecruiters: AtsConnector = {
  ats: 'smartrecruiters',
  boardUrl: (token) => `https://api.smartrecruiters.com/v1/companies/${enc(token)}/postings`,
  async read(source, deps, opts = {}) {
    // The listing, to its end (a check by hand or of a candidate: its first page): one pass per country the board is read for, else one pass over everything.
    const countries = normalizeCountries(source.countries);
    const byId = new Map<string, Record<string, unknown>>();
    const firstPageOnly = opts.listOnly === true && opts.firstPage === true;
    let calls = 0;
    let complete = true;
    let stated = 0;
    for (const country of countries.length ? countries : [null]) {
      const pass = await listSmartRecruiters(source.boardToken, country, deps, firstPageOnly ? 1 : undefined);
      calls += pass.calls;
      complete &&= pass.complete;
      stated += pass.complete ? pass.rows.length : Math.max(pass.total ?? 0, pass.rows.length);
      for (const row of pass.rows) if (!byId.has(str(row.id)!)) byId.set(str(row.id)!, row);
    }
    const rows = [...byId.values()];
    const boardCompanyName = rows.map((r) => str(obj(r.company)?.name)).find((n) => !!n) ?? null;
    const as = named(source, boardCompanyName);
    // The listing row states the posting's place and date: enough to route it and to diff closures.
    const entries = rows
      .map((row) => ({ row, listed: mapSmartRecruitersPosting(row, null, as, deps.now) }))
      .filter((e): e is { row: Record<string, unknown>; listed: ProviderJobInput } => !!e.listed);
    const listing = entries.map((e) => e.listed);
    const listedIds = listing.map(byExternalId);
    // A listing read to its end is counted; one cut short states its own total.
    const listedCount = complete ? listing.length : Math.max(stated, listing.length);
    const done = (inputs: ProviderJobInput[], pendingDetails: number, failedDetails = 0): BoardRead => ({ inputs, listing, listedIds, listedCount, complete, calls, pendingDetails, failedDetails, boardCompanyName });
    if (opts.listOnly) return done([], 0);

    // Posting texts, one request each: postings we have not stored first, then the rows saved longest ago.
    const storedIds = opts.storedIds ?? ((listed: ProviderJobInput) => [listed.externalId]);
    const known = new Map<string, Date | null>();
    const wanted = entries.filter((e) => {
      const ids = storedIds(e.listed);
      if (ids.length === 0) return false;
      // Stored = every copy of the posting is among our open rows; its age is the oldest copy's.
      if (opts.known && ids.every((id) => opts.known!.has(id))) {
        const times = ids.map((id) => opts.known!.get(id)?.getTime() ?? Number.NEGATIVE_INFINITY);
        const oldest = Math.min(...times);
        known.set(e.listed.externalId, Number.isFinite(oldest) ? new Date(oldest) : null);
      }
      return true;
    });
    const idOf = (e: { listed: ProviderJobInput }) => e.listed.externalId;
    const fresh = wanted.filter((e) => !known.has(idOf(e)));
    const batch = prioritise(wanted, idOf, known, Math.max(0, opts.detailsBudget ?? SR_MAX_DETAILS));
    if (deps.signal?.aborted) return done([], fresh.length);
    // A failed text request skips that posting for this run; it never fails the board.
    const failed = new Set<string>();
    // Told to slow down (429): no further text is asked for in this run.
    let limited = false;
    const withText = await mapLimit(batch, SR_CONCURRENCY, async (e) => {
      if (deps.signal?.aborted || limited) return null;
      const url = `${this.boardUrl(source.boardToken)}/${enc(str(e.row.id)!)}`;
      try {
        // One gate for the host, shared by every board being read (see SR_HOST_CONCURRENCY). What
        // changed while this request waited for its turn still counts: no request after a 429 or a cut.
        const detail = await smartRecruitersTextGate(async () => {
          if (deps.signal?.aborted || limited) return undefined;
          calls += 1;
          return getJson(url, deps);
        });
        if (detail === undefined) return null;
        const input = mapSmartRecruitersPosting(e.row, detail, as, deps.now);
        if (!input) failed.add(idOf(e));
        return input;
      } catch (err) {
        // The run's own time limit is not the board's failure: the posting is simply not read yet.
        if (deps.signal?.aborted) return null;
        if (err instanceof BoardFetchError && err.status === 429) limited = true;
        failed.add(idOf(e));
        return null;
      }
    });
    const inputs = withText.filter((x): x is ProviderJobInput => !!x);
    // Of the postings we do not hold: asked for and not read (failed), and not asked for yet (pending).
    const read = new Set(inputs.map(byExternalId));
    const failedDetails = fresh.filter((e) => failed.has(idOf(e))).length;
    const pendingDetails = fresh.filter((e) => !read.has(idOf(e)) && !failed.has(idOf(e))).length;
    return done(inputs, pendingDetails, failedDetails);
  },
};

// ── The registry ──────────────────────────────────────────────────────────

/**
 * The connectors that exist whatever the environment says. 北森 is not among
 * them: its connector is built only while CN_ATS_BEISEN_ENABLED is true
 * (`connectorFor`), so with the flag off no code path holds an object that
 * could build a request to a tenant board.
 */
export const CONNECTORS: Readonly<Record<Exclude<BoardAts, 'beisen'>, AtsConnector>> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workable,
  recruitee,
  personio,
  lever_eu: leverEu,
};

/** Is the system's connector switched on in this environment? (Workable: unless its kill switch is set; 北森: only with its flag.) */
export function connectorEnabled(ats: BoardAts, env: EnvSource = process.env): boolean {
  if (ats === 'workable') return workableEnabled(env);
  if (ats === 'beisen') return beisenEnabled(env);
  return true;
}

/** The systems whose connector is switched on, in the order of PUBLIC_ATS. */
export function enabledAts(env: EnvSource = process.env): BoardAts[] {
  return PUBLIC_ATS.filter((ats) => connectorEnabled(ats, env));
}

/**
 * The connector of a system. Throws BoardFetchError('connector_disabled')
 * when it is switched off in `env`: the caller skips the source and leaves its
 * postings as they are.
 */
export function connectorFor(ats: BoardAts, env: EnvSource = process.env): AtsConnector {
  if (!connectorEnabled(ats, env)) throw new BoardFetchError(CONNECTOR_DISABLED);
  if (ats === 'beisen') return createBeisenConnector({ maxPostings: beisenMaxPostingsPerRun(env), denylist: tenantDenylist(env) });
  return CONNECTORS[ats];
}
