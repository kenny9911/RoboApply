// server/src/features/jobs/sources/atsPublic/connectors.ts — public ATS job-board
// connectors (TASK_PLAN.md WP-42; CN_TW_LAUNCH_PLAN.md WP-TW-JOBS).
//
// Each connector reads the endpoint the ATS publishes for embedding a job
// board and maps every posting to the normalizer's input (provider
// 'ats_public', sourceBoard = the ATS name):
//
//   greenhouse       GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//   lever            GET api.lever.co/v0/postings/{site}?mode=json&skip&limit
//   ashby            GET api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
//   smartrecruiters  GET api.smartrecruiters.com/v1/companies/{id}/postings (+ /postings/{id} for the text)
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
// `listOnly` (admin "Check now", candidate validation) reads the listing and
// nothing else. With `firstPage` it asks SmartRecruiters for ONE page per
// country pass and takes the number of postings from the board's own total:
// what a check needs (does it answer, how many does it list, which company)
// is on the first page, and paging a large board to its end would be up to
// 200 requests. `boardCompany` also asks the board for the company name it
// states (Greenhouse: one more documented request; SmartRecruiters: already in
// the listing; Lever and Ashby state none).

import { resolveCountry } from '../../geo/index.js';
import type { ProviderJobInput } from '../../normalize/index.js';
import type { PublicAts } from './contract.js';
import { BoardFetchError, getJson, type HttpDeps } from './http.js';
import { arr, atsSourceName, decodeEntities, externalIdFor, LEVER_MAX_PAGES, normalizeCountries, num, obj, SMARTRECRUITERS_MAX_PAGES, str } from './shared.js';

/** What a connector needs to know about one career source. */
export interface BoardSource {
  ats: PublicAts;
  boardToken: string;
  companyName: string;
  /** Ops tag: the country the board mainly hires in (weak hint only, never a filter). */
  countryCode: string | null;
  /** ISO codes the board is read for; empty or absent = every country. */
  countries?: readonly string[] | null;
}

export interface BoardRead {
  /** Postings whose text was read this run, in the normalizer's input shape (not yet routed to a market). */
  inputs: ProviderJobInput[];
  /** EVERY posting the board lists, mapped from the listing alone (enough to place it; no text for SmartRecruiters). */
  listing: ProviderJobInput[];
  /** externalIds of `listing`. */
  listedIds: string[];
  /** How many postings the board lists: `listing.length`, or the board's own total when only the first page was read. */
  listedCount: number;
  /** False when the listing was cut short (a paging safety stop): closures are then skipped. */
  complete: boolean;
  /** HTTP requests made. */
  calls: number;
  /** Listed postings we have not stored yet whose text this run did not ask for (the per-run budget was used up, or the run ran out of time). */
  pendingDetails: number;
  /** Listed postings we have not stored yet whose text this run asked for and could not read. */
  failedDetails: number;
  /** The company name the board itself states, when it states one and was asked or already carries it. */
  boardCompanyName: string | null;
}

export interface ConnectorDeps extends HttpDeps {
  now: Date;
}

export interface ReadOptions {
  /** Read the listing only: no posting texts, no inputs. */
  listOnly?: boolean;
  /**
   * With `listOnly`: one request per country pass where the listing is paged
   * without its texts (SmartRecruiters). `listedCount` is then the board's own
   * total and the read is `complete` only when that page was the whole listing.
   */
  firstPage?: boolean;
  /**
   * Our open rows of this board: externalId -> when ingest last saved the
   * posting (RAJob.lastSeenAt). Decides which posting texts SmartRecruiters reads.
   */
  known?: ReadonlyMap<string, Date | null>;
  /**
   * The externalIds a listed posting is stored under by this deployment
   * (./market.ts `storedIdsOf`). Empty = the posting is not written here, so
   * its text is never requested. Default: the posting's own externalId.
   */
  storedIds?: (listed: ProviderJobInput) => string[];
  /** SmartRecruiters posting texts read this run (default SR_MAX_DETAILS). */
  detailsBudget?: number;
  /** Also report the company name the board states (see the header). */
  boardCompany?: boolean;
}

/** A source registered without a company name carries its board id as the name until the board's own name is read. */
export function hasPlaceholderName(source: Pick<BoardSource, 'companyName' | 'boardToken'>): boolean {
  return source.companyName.trim() === source.boardToken;
}

/** The source as the postings are mapped: with the board's stated name in place of a placeholder. */
function named(source: BoardSource, stated: string | null): BoardSource {
  return stated && hasPlaceholderName(source) ? { ...source, companyName: stated } : source;
}

export interface AtsConnector {
  ats: PublicAts;
  /** The listing URL (shown to ops in the admin panel; the first request). */
  boardUrl(boardToken: string): string;
  read(source: BoardSource, deps: ConnectorDeps, opts?: ReadOptions): Promise<BoardRead>;
}

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

const byExternalId = (i: ProviderJobInput) => i.externalId;

const enc = encodeURIComponent;

function base(source: BoardSource, postingId: string | number, now: Date): Pick<
  ProviderJobInput,
  'externalId' | 'sourceBoard' | 'company' | 'sourcePublisher' | 'applyIsDirect' | 'fetchedAt'
> {
  return {
    externalId: externalIdFor(source.boardToken, postingId),
    sourceBoard: source.ats,
    company: source.companyName,
    sourcePublisher: atsSourceName(source.companyName, source.ats),
    applyIsDirect: true,
    fetchedAt: now.toISOString(),
  };
}

/** ISO alpha-2 from a code or a country name ("tw", "Taiwan", "臺灣"), else null. */
function isoCountry(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  return resolveCountry(s)?.code ?? null;
}

/** The posting's own country when it states one, else the board tag as a weak (estimated) hint. */
function countryFields(stated: string | null, source: BoardSource): Pick<ProviderJobInput, 'locationCountry' | 'locationCountryEstimated'> {
  if (stated) return { locationCountry: stated, locationCountryEstimated: false };
  if (source.countryCode) return { locationCountry: source.countryCode, locationCountryEstimated: true };
  return {};
}

function dateFromMs(v: unknown): string | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = str(v);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// ── Greenhouse ────────────────────────────────────────────────────────────

export function mapGreenhouseJob(raw: unknown, source: BoardSource, now: Date): ProviderJobInput | null {
  const j = obj(raw);
  const id = j && (num(j.id) ?? str(j.id));
  const title = j && str(j.title);
  if (!j || id === null || !title) return null;
  const url = str(j.absolute_url);
  const location = str(obj(j.location)?.name);
  const offices = arr(j.offices).map((o) => obj(o)?.location ?? obj(o)?.name);
  const content = str(j.content);
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

export const greenhouse: AtsConnector = {
  ats: 'greenhouse',
  boardUrl: (token) => `https://boards-api.greenhouse.io/v1/boards/${enc(token)}/jobs?content=true`,
  async read(source, deps, opts = {}) {
    // listOnly: the same listing without the posting texts.
    const url = opts.listOnly ? `https://boards-api.greenhouse.io/v1/boards/${enc(source.boardToken)}/jobs` : this.boardUrl(source.boardToken);
    const body = obj(await getJson(url, deps));
    if (!body || !Array.isArray(body.jobs)) throw new BoardFetchError('unexpected_shape');
    let calls = 1;
    let boardCompanyName: string | null = null;
    if (opts.boardCompany || hasPlaceholderName(source)) {
      boardCompanyName = await greenhouseBoardName(source.boardToken, deps);
      calls += 1;
    }
    const as = named(source, boardCompanyName);
    // The whole board comes in one answer: every listed posting is handed on.
    const listing = body.jobs.map((raw) => mapGreenhouseJob(raw, as, deps.now)).filter((x): x is ProviderJobInput => !!x);
    return { inputs: opts.listOnly ? [] : listing, listing, listedIds: listing.map(byExternalId), listedCount: listing.length, complete: true, calls, pendingDetails: 0, failedDetails: 0, boardCompanyName };
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

export const lever: AtsConnector = {
  ats: 'lever',
  boardUrl: (token) => `https://api.lever.co/v0/postings/${enc(token)}?mode=json`,
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
    return { inputs: opts.listOnly ? [] : listing, listing, listedIds: listing.map(byExternalId), listedCount: listing.length, complete, calls, pendingDetails: 0, failedDetails: 0, boardCompanyName: null };
  },
};

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

export const CONNECTORS: Readonly<Record<PublicAts, AtsConnector>> = { greenhouse, lever, ashby, smartrecruiters };

export function connectorFor(ats: PublicAts): AtsConnector {
  return CONNECTORS[ats];
}
