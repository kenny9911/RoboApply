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
// Caps: at most MAX_POSTINGS_PER_BOARD inputs per board and run, and
// SmartRecruiters' posting texts (one request each) for SR_MAX_DETAILS
// postings per run. Which postings fill the cap is decided by `prioritise`:
// postings we have not saved yet first, then the ones ingest refreshed
// longest ago, so a large board is covered in full over a few runs.
// `listOnly` (admin "Check now") reads the listing and nothing else.

import { resolveCountry } from '../../geo/index.js';
import type { ProviderJobInput } from '../../normalize/index.js';
import type { PublicAts } from './contract.js';
import { BoardFetchError, getJson, type HttpDeps } from './http.js';
import { arr, atsSourceName, decodeEntities, externalIdFor, MAX_POSTINGS_PER_BOARD, num, obj, str } from './shared.js';

/** What a connector needs to know about one career source. */
export interface BoardSource {
  ats: PublicAts;
  boardToken: string;
  companyName: string;
  /** Ops tag: the country the board mainly hires in (weak hint only). */
  countryCode: string | null;
}

export interface BoardRead {
  /** Postings in the normalizer's input shape (at most MAX_POSTINGS_PER_BOARD). */
  inputs: ProviderJobInput[];
  /** externalIds of EVERY posting the board lists (closure detection). */
  listedIds: string[];
  /** False when the listing was cut short (paging cap): closures are then skipped. */
  complete: boolean;
  /** HTTP requests made. */
  calls: number;
}

export interface ConnectorDeps extends HttpDeps {
  now: Date;
}

export interface ReadOptions {
  /** Read the listing only: no posting texts, no inputs (admin "Check now" counts what the board lists). */
  listOnly?: boolean;
  /**
   * Our open rows of this board: externalId → when ingest last saved the
   * posting (RAJob.lastSeenAt). Decides which postings fill the per-run caps.
   */
  known?: ReadonlyMap<string, Date | null>;
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

export const greenhouse: AtsConnector = {
  ats: 'greenhouse',
  boardUrl: (token) => `https://boards-api.greenhouse.io/v1/boards/${enc(token)}/jobs?content=true`,
  async read(source, deps, opts = {}) {
    // listOnly: the same listing without the posting texts.
    const url = opts.listOnly ? `https://boards-api.greenhouse.io/v1/boards/${enc(source.boardToken)}/jobs` : this.boardUrl(source.boardToken);
    const body = obj(await getJson(url, deps));
    if (!body || !Array.isArray(body.jobs)) throw new BoardFetchError('unexpected_shape');
    const listed = body.jobs.map((raw) => mapGreenhouseJob(raw, source, deps.now)).filter((x): x is ProviderJobInput => !!x);
    const inputs = opts.listOnly ? [] : prioritise(listed, byExternalId, opts.known, MAX_POSTINGS_PER_BOARD);
    return { inputs, listedIds: listed.map(byExternalId), complete: true, calls: 1 };
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
    const listed: ProviderJobInput[] = [];
    let calls = 0;
    let complete = false;
    for (let skip = 0; skip < MAX_POSTINGS_PER_BOARD; skip += LEVER_PAGE) {
      const page = await getJson(`${this.boardUrl(source.boardToken)}&skip=${skip}&limit=${LEVER_PAGE}`, deps);
      calls += 1;
      if (!Array.isArray(page)) throw new BoardFetchError('unexpected_shape');
      for (const raw of page) {
        const input = mapLeverPosting(raw, source, deps.now);
        if (input) listed.push(input);
      }
      if (page.length < LEVER_PAGE) {
        complete = true;
        break;
      }
    }
    const inputs = opts.listOnly ? [] : prioritise(listed, byExternalId, opts.known, MAX_POSTINGS_PER_BOARD);
    return { inputs, listedIds: listed.map(byExternalId), complete, calls };
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
    const listed = body.jobs.map((raw) => mapAshbyJob(raw, source, deps.now)).filter((x): x is ProviderJobInput => !!x);
    const inputs = opts.listOnly ? [] : prioritise(listed, byExternalId, opts.known, MAX_POSTINGS_PER_BOARD);
    return { inputs, listedIds: listed.map(byExternalId), complete: true, calls: 1 };
  },
};

// ── SmartRecruiters ───────────────────────────────────────────────────────

const SR_PAGE = 100;
/** Posting texts read per board and run (one request each). */
export const SR_MAX_DETAILS = 100;
const SR_CONCURRENCY = 4;

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

export const smartrecruiters: AtsConnector = {
  ats: 'smartrecruiters',
  boardUrl: (token) => `https://api.smartrecruiters.com/v1/companies/${enc(token)}/postings`,
  async read(source, deps, opts = {}) {
    const listedRaw: Record<string, unknown>[] = [];
    let calls = 0;
    let complete = false;
    for (let offset = 0; offset < MAX_POSTINGS_PER_BOARD; offset += SR_PAGE) {
      const page = obj(await getJson(`${this.boardUrl(source.boardToken)}?limit=${SR_PAGE}&offset=${offset}`, deps));
      calls += 1;
      if (!page || !Array.isArray(page.content)) throw new BoardFetchError('unexpected_shape');
      for (const raw of page.content) {
        const row = obj(raw);
        if (row && str(row.id) && str(row.name)) listedRaw.push(row);
      }
      const total = num(page.totalFound);
      if (page.content.length < SR_PAGE || (total !== null && offset + SR_PAGE >= total)) {
        complete = true;
        break;
      }
    }
    const idOf = (r: Record<string, unknown>) => externalIdFor(source.boardToken, str(r.id)!);
    const listedIds = listedRaw.map(idOf);
    if (opts.listOnly) return { inputs: [], listedIds, complete, calls };
    // The listing carries no posting text; read it for SR_MAX_DETAILS postings
    // per run, new ones first, then the longest-unrefreshed (see `prioritise`).
    // A failed detail skips that posting this run; it never fails the board.
    const batch = prioritise(listedRaw, idOf, opts.known, SR_MAX_DETAILS);
    if (deps.signal?.aborted) return { inputs: [], listedIds, complete, calls };
    const withText = await mapLimit(batch, SR_CONCURRENCY, async (row) => {
      const url = `${this.boardUrl(source.boardToken)}/${enc(str(row.id)!)}`;
      calls += 1;
      try {
        return mapSmartRecruitersPosting(row, await getJson(url, deps), source, deps.now);
      } catch {
        return null;
      }
    });
    const inputs = withText.filter((x): x is ProviderJobInput => !!x);
    return { inputs, listedIds, complete, calls };
  },
};

export const CONNECTORS: Readonly<Record<PublicAts, AtsConnector>> = { greenhouse, lever, ashby, smartrecruiters };

export function connectorFor(ats: PublicAts): AtsConnector {
  return CONNECTORS[ats];
}
