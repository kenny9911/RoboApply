// @vitest-environment node
//
// USAJOBS adapter (MKT-5D; JI-9): off without a key, the documented request,
// the field mapping (pay range, close date, who may apply), paging and the
// daily cadence. Nothing here reaches the network: the API is a scripted fake,
// the key is a test value, the clock is fixed. The fixture is the reference's
// own sample plus one SYNTHETIC item (__fixtures__/usajobs/README.md).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBrand } from '../../../platform/brand/index.js';
import { adaptersForBrand, listEnabledAdaptersFor, sourcesForBrand } from '../ingest/providers.js';
import { NO_DATE_EXPIRY_PROVIDERS, PROVIDER_META, normalizeProviderJob } from '../normalize/index.js';
import { adapterCostModel, getSourceAdapter, jobSourceKind, jobSourceTransport, registeredSourceAdapters, type SourceFetchResult, type SourceQuery } from './index.js';
import { ensureUsaJobsAdapter, usaJobsAdapter } from './register.js';
import {
  USAJOBS_HIRING_PATHS,
  USAJOBS_HIRING_PATH_TAG,
  USAJOBS_MAX_BYTES,
  USAJOBS_MAX_PAGE,
  USAJOBS_MIN_BUDGET_MS,
  USAJOBS_PAGE_SIZE,
  createUsaJobsAdapter,
  emptyUsaJobsCursor,
  formatUsaJobsCursor,
  parseUsaJobsCursor,
  parseUsaJobsPage,
  requestUsaJobs,
  usaJobsCredentials,
  usaJobsDay,
  usaJobsHiringPath,
  usaJobsItemToInput,
  usaJobsLink,
  usaJobsPay,
  usaJobsPayPeriod,
  usaJobsSearchUrl,
  usaJobsStatus,
  usaJobsWindowDays,
  type UsaJobsCursor,
  type UsaJobsFetchLike,
  type UsaJobsInput,
  type UsaJobsItem,
} from './usaJobs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TEXT = readFileSync(join(HERE, '__fixtures__', 'usajobs', 'search.json'), 'utf8');
const NOW = new Date('2026-10-12T02:00:00.000Z');
/** Test values: not a real key, and an address on the reserved test host. */
const KEY = 'test-key-not-a-real-one';
const EMAIL = 'ops@example.invalid';
const ENV = { USAJOBS_API_KEY: KEY, USAJOBS_USER_AGENT_EMAIL: EMAIL };

// ── Helpers ─────────────────────────────────────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixtureItems(): UsaJobsItem[] {
  const page = parseUsaJobsPage(FIXTURE_TEXT);
  if (!page.ok) throw new Error(page.error);
  return page.items;
}

/** The reference's own sample item, and the SYNTHETIC one. */
const documented = (): UsaJobsItem => clone(fixtureItems()[0]!);
const synthetic = (): UsaJobsItem => clone(fixtureItems()[1]!);

type Descriptor = Record<string, unknown> & { UserArea: { Details: Record<string, unknown> } };
const descriptorOf = (item: UsaJobsItem): Descriptor => item.MatchedObjectDescriptor as Descriptor;

/** A SYNTHETIC item with `over` laid on its descriptor and `details` on its `UserArea.Details`. */
function itemWith(over: Record<string, unknown> = {}, details: Record<string, unknown> = {}, id = '900000777'): UsaJobsItem {
  const item = synthetic();
  item.MatchedObjectId = id;
  Object.assign(descriptorOf(item), over);
  Object.assign(descriptorOf(item).UserArea.Details, details);
  return item;
}

function inputOf(item: UsaJobsItem): UsaJobsInput {
  const mapped = usaJobsItemToInput(item, NOW);
  if ('skip' in mapped) throw new Error(`the item was skipped: ${mapped.skip}`);
  return mapped.input;
}

const normalized = (input: UsaJobsInput, publicDisplayProviders: string[] = []) => normalizeProviderJob(input, 'usajobs', { market: 'intl', now: NOW, publicDisplayProviders });

/** An answer of `n` SYNTHETIC items whose control numbers belong to `tag`. */
function answerOf(n: number, tag: string): string {
  const items = Array.from({ length: n }, (_, i) => itemWith({}, {}, `9${tag}${String(i).padStart(4, '0')}`));
  return JSON.stringify({ LanguageCode: 'EN', SearchParameters: {}, SearchResult: { SearchResultCount: n, SearchResultCountAll: n, SearchResultItems: items } });
}

interface Call {
  url: string;
  datePosted: string | null;
  page: string | null;
  perPage: string | null;
  params: string[];
  headers: Record<string, string>;
  redirect: string | undefined;
}

type Script = (call: Call) => number | { status: number } | { body: string } | { throws: Error };

/** A scripted API: `script` answers each request with an item count, a status, a body or a throw. */
function fakeApi(script: Script) {
  const calls: Call[] = [];
  const fetch: UsaJobsFetchLike = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      url,
      datePosted: u.searchParams.get('DatePosted'),
      page: u.searchParams.get('Page'),
      perPage: u.searchParams.get('ResultsPerPage'),
      params: [...u.searchParams.keys()],
      headers: init.headers ?? {},
      redirect: init.redirect,
    };
    calls.push(call);
    const answer = script(call);
    if (typeof answer === 'number') return { ok: true, status: 200, text: async () => answerOf(answer, `${call.datePosted}${call.page}`) };
    if ('throws' in answer) throw answer.throws;
    if ('status' in answer) return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => '' };
    return { ok: true, status: 200, text: async () => answer.body };
  };
  return { fetch, calls };
}

const query = (cursor?: string | null, market: SourceQuery['market'] = 'intl'): SourceQuery => ({
  id: 'q-usajobs',
  provider: 'usajobs',
  market,
  origin: 'bank_sync',
  params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor } : {}) },
});

interface Harness {
  adapter: ReturnType<typeof createUsaJobsAdapter>;
  cursor: string | null;
  /** One fetch at `now`; the stored cursor follows what ingest would write. */
  step(now: Date, ctx?: { budgetMs?: number; signal?: AbortSignal }): Promise<SourceFetchResult>;
  /** Fetches at `now` until the adapter says there is no more to do right now. */
  drain(now: Date): Promise<SourceFetchResult[]>;
  state(): UsaJobsCursor;
}

function harness(deps: Parameters<typeof createUsaJobsAdapter>[0] & { cursor?: string | null }): Harness {
  const adapter = createUsaJobsAdapter({ env: ENV, ...deps });
  const h: Harness = {
    adapter,
    cursor: deps.cursor ?? null,
    async step(now, ctx = {}) {
      const result = await adapter.fetch(query(h.cursor), { now, ...ctx });
      // Ingest stores a cursor only for a result without an error (pipeline.ts `runIngestQuery`).
      if (!result.error && result.cursor) h.cursor = result.cursor;
      return result;
    },
    async drain(now) {
      const out: SourceFetchResult[] = [];
      for (let i = 0; i < 100; i++) {
        const result = await h.step(now);
        out.push(result);
        if (result.error || result.exhausted !== false) return out;
      }
      throw new Error('the run did not end');
    },
    state: () => parseUsaJobsCursor(h.cursor),
  };
  return h;
}

const at = (iso: string) => new Date(iso);

// ── Switches ────────────────────────────────────────────────────────────────

describe('usajobs: off until a key is set', () => {
  it('JI-9: without a key the adapter reports disabled with reason no_key and fetches nothing', async () => {
    expect(usaJobsStatus({})).toEqual({ enabled: false, reason: 'no_key' });
    const api = fakeApi(() => 2);
    const adapter = createUsaJobsAdapter({ env: {}, fetch: api.fetch });
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.disabledReason?.()).toBe('no_key');
    expect(await adapter.fetch(query(), { now: NOW })).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect(api.calls).toEqual([]);
    // Even asked directly, no request is built without the key.
    expect(await requestUsaJobs({ datePosted: 1, page: 1 }, { env: {}, fetch: api.fetch })).toEqual({ ok: false, error: 'no_key' });
    expect(api.calls).toEqual([]);
  });

  it('needs the key AND the e-mail address it was issued to', () => {
    expect(usaJobsStatus({ USAJOBS_API_KEY: KEY })).toEqual({ enabled: false, reason: 'no_key' });
    expect(usaJobsStatus({ USAJOBS_USER_AGENT_EMAIL: EMAIL })).toEqual({ enabled: false, reason: 'no_key' });
    expect(usaJobsStatus({ USAJOBS_API_KEY: '   ', USAJOBS_USER_AGENT_EMAIL: EMAIL })).toEqual({ enabled: false, reason: 'no_key' });
    expect(usaJobsStatus({ USAJOBS_API_KEY: KEY, USAJOBS_USER_AGENT_EMAIL: 'not an address' })).toEqual({ enabled: false, reason: 'no_key' });
    expect(usaJobsStatus(ENV)).toEqual({ enabled: true });
    expect(usaJobsCredentials({ USAJOBS_API_KEY: `  ${KEY} `, USAJOBS_USER_AGENT_EMAIL: ` ${EMAIL} ` })).toEqual({ key: KEY, email: EMAIL });
  });

  it('a value that could break out of its header is not a credential', () => {
    expect(usaJobsCredentials({ USAJOBS_API_KEY: `${KEY}\r\nX-Injected: 1`, USAJOBS_USER_AGENT_EMAIL: EMAIL })).toBeNull();
    expect(usaJobsCredentials({ USAJOBS_API_KEY: KEY, USAJOBS_USER_AGENT_EMAIL: `${EMAIL}\nX-Injected: 1` })).toBeNull();
    expect(usaJobsCredentials({ USAJOBS_API_KEY: 'ключ', USAJOBS_USER_AGENT_EMAIL: EMAIL })).toBeNull();
  });

  it('USAJOBS_DISABLED=true turns it off even with a key, and nothing is fetched', async () => {
    for (const value of ['true', 'TRUE', '1', 'on', 'yes']) expect(usaJobsStatus({ ...ENV, USAJOBS_DISABLED: value })).toEqual({ enabled: false, reason: 'disabled' });
    for (const value of ['false', '0', '', 'off']) expect(usaJobsStatus({ ...ENV, USAJOBS_DISABLED: value })).toEqual({ enabled: true });
    // The switch is named before the missing key.
    expect(usaJobsStatus({ USAJOBS_DISABLED: 'true' })).toEqual({ enabled: false, reason: 'disabled' });
    const api = fakeApi(() => 2);
    const adapter = createUsaJobsAdapter({ env: { ...ENV, USAJOBS_DISABLED: 'true' }, fetch: api.fetch });
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.disabledReason?.()).toBe('disabled');
    expect(await adapter.fetch(query(), { now: NOW })).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect(api.calls).toEqual([]);
  });

  it('describes itself: a free cursor source of the international market, United States only, not metered', () => {
    const adapter = createUsaJobsAdapter({ env: ENV });
    expect(adapter).toMatchObject({ provider: 'usajobs', kind: 'cursor', markets: ['intl'], costModel: 'free', sourceBoards: ['usajobs'] });
    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.disabledReason?.()).toBeNull();
    expect(adapter.transport?.()).toBe('api');
    expect(adapter.dailyCallLimit()).toBeNull();
    expect(adapterCostModel(adapter)).toBe('free');
    expect(adapter.supportsCountry('US')).toBe(true);
    expect(adapter.supportsCountry('us')).toBe(true);
    for (const country of ['CA', 'GB', 'TW', 'CN', '*', '']) expect(adapter.supportsCountry(country)).toBe(false);
    expect(adapter.ownRun).toBeUndefined();
  });
});

// ── One request ─────────────────────────────────────────────────────────────

describe('usajobs: one request', () => {
  it('JI-9: asks the documented endpoint with DatePosted, ResultsPerPage=500 and Page, and nothing else', async () => {
    expect(usaJobsSearchUrl({ datePosted: 7, page: 1 })).toBe('https://data.usajobs.gov/api/Search?DatePosted=7&ResultsPerPage=500&Page=1');
    expect(usaJobsSearchUrl({ datePosted: 1, page: 3 })).toBe('https://data.usajobs.gov/api/Search?DatePosted=1&ResultsPerPage=500&Page=3');
    // The API accepts 0 to 60 days.
    expect(new URL(usaJobsSearchUrl({ datePosted: 400, page: 1 })).searchParams.get('DatePosted')).toBe('60');
    const api = fakeApi(() => ({ body: FIXTURE_TEXT }));
    const page = await requestUsaJobs({ datePosted: 7, page: 1 }, { env: ENV, fetch: api.fetch });
    expect(page.ok && page.items.length).toBe(2);
    expect(api.calls[0]!.params).toEqual(['DatePosted', 'ResultsPerPage', 'Page']);
    expect(api.calls[0]!.url.startsWith('https://data.usajobs.gov/api/Search?')).toBe(true);
  });

  it('JI-9: sends the three documented headers, the contact address as the User-Agent, and never follows a redirect', async () => {
    const api = fakeApi(() => ({ body: FIXTURE_TEXT }));
    await requestUsaJobs({ datePosted: 1, page: 1 }, { env: ENV, fetch: api.fetch });
    const call = api.calls[0]!;
    // Names as the authentication guide writes them (read 2026-10-12).
    expect(Object.keys(call.headers).sort()).toEqual(['Accept', 'Authorization-Key', 'Host', 'User-Agent']);
    expect(call.headers.Host).toBe('data.usajobs.gov');
    expect(call.headers['User-Agent']).toBe(EMAIL);
    expect(call.headers['Authorization-Key'] === KEY).toBe(true);
    expect(call.redirect).toBe('error');
    // The key travels in its header only: never in the address.
    expect(call.url).not.toContain(KEY);
    expect(call.url).not.toContain(EMAIL);
  });

  it('a refused key, a redirect and a failed connection are short error codes that hold no credential', async () => {
    const codes: string[] = [];
    for (const script of [
      () => ({ status: 401 }),
      () => ({ status: 403 }),
      () => ({ status: 429 }),
      () => ({ status: 500 }),
      () => ({ status: 302 }),
      () => ({ throws: new TypeError('fetch failed', { cause: new Error('unexpected redirect') }) }),
      () => ({ throws: new Error(`connect ECONNREFUSED with ${KEY}`) }),
      () => ({ body: '<html>not json</html>' }),
      () => ({ body: '{"SearchResult":{}}' }),
      () => ({ body: '[]' }),
    ] as Script[]) {
      const page = await requestUsaJobs({ datePosted: 1, page: 1 }, { env: ENV, fetch: fakeApi(script).fetch });
      expect(page.ok).toBe(false);
      if (!page.ok) codes.push(page.error);
    }
    expect(codes).toEqual(['http_401', 'http_403', 'http_429', 'http_500', 'redirect', 'redirect', 'network', 'not_json', 'bad_shape', 'bad_shape']);
    expect(codes.join(' ')).not.toContain(KEY);
  });

  it('refuses an oversized body, by its declared length or by what arrived', async () => {
    const declared: UsaJobsFetchLike = async () => ({ ok: true, status: 200, headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(USAJOBS_MAX_BYTES + 1) : null) }, text: async () => FIXTURE_TEXT });
    expect(await requestUsaJobs({ datePosted: 1, page: 1 }, { env: ENV, fetch: declared })).toEqual({ ok: false, error: 'response_too_large' });
    const arrived: UsaJobsFetchLike = async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(USAJOBS_MAX_BYTES + 1) });
    expect(await requestUsaJobs({ datePosted: 1, page: 1 }, { env: ENV, fetch: arrived })).toEqual({ ok: false, error: 'response_too_large' });
  });

  it('gives up after its timeout and when the caller aborts', async () => {
    const hang: UsaJobsFetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await requestUsaJobs({ datePosted: 1, page: 1 }, { env: ENV, fetch: hang, timeoutMs: 5 })).toEqual({ ok: false, error: 'timeout' });
    const controller = new AbortController();
    const pending = requestUsaJobs({ datePosted: 1, page: 1 }, { env: ENV, fetch: hang, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    const before = new AbortController();
    before.abort();
    const api = fakeApi(() => 1);
    expect(await requestUsaJobs({ datePosted: 1, page: 1 }, { env: ENV, fetch: api.fetch, signal: before.signal })).toEqual({ ok: false, error: 'aborted' });
    expect(api.calls).toEqual([]);
  });
});

// ── Mapping ─────────────────────────────────────────────────────────────────

describe('usajobs: a search result becomes a posting', () => {
  it('JI-9: maps the documented sample field by field', () => {
    const input = inputOf(documented());
    expect(input).toMatchObject({
      externalId: 'usajobs:21947200',
      sourceBoard: 'usajobs',
      title: 'IT SPECIALIST (INFOSEC/NETWORK)',
      company: 'Space and Naval Warfare Systems Command',
      applyUrl: 'https://www.usajobs.gov/GetJob/ViewDetails/21947200?PostingChannelID=RESTAPI',
      sourceUrl: 'https://www.usajobs.gov/GetJob/ViewDetails/21947200',
      sourcePublisher: 'USAJOBS',
      location: 'Point Loma Complex, San Diego, California',
      locations: ['Point Loma Complex, San Diego, California'],
      locationRegion: 'California',
      locationCountry: 'United States',
      employmentType: 'Full Time',
      salaryMin: 92108,
      salaryMax: 119746,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
      payFromFieldsOnly: true,
      postedAt: '2016-06-05',
      expiresAt: '2016-12-01',
      fetchedAt: NOW,
    });
    // No applicant count is read from this source.
    expect(input.applicantCount).toBeUndefined();
    expect(input.applicantCountSource).toBeUndefined();
  });

  it('JI-9: the pay range is min, max, period and USD as stated; the close date is the deadline, through that day', () => {
    const job = normalized(inputOf(documented()));
    expect({ min: job.salaryMin, max: job.salaryMax, currency: job.salaryCurrency, period: job.salaryPeriod, disclosed: job.salaryDisclosed, source: job.salarySource }).toEqual({
      min: 92108,
      max: 119746,
      currency: 'USD',
      period: 'year',
      disclosed: true,
      source: 'provider',
    });
    expect(job.salaryAnnualMin).toBe(92108);
    expect(job.salaryAnnualMax).toBe(119746);
    expect(job.expiresAt?.toISOString()).toBe('2016-12-01T23:59:59.999Z');
    expect(job.postedAt?.toISOString()).toBe('2016-06-05T00:00:00.000Z');
    expect(job.postedAtEstimated).toBe(false);
    expect(job.locationCountry).toBe('US');
    expect(job.market).toBe('intl');
    expect(job.employmentType).toBe('full_time');
    expect(job.sourceBoard).toBe('usajobs');
    expect(job.sourceName).toBe('USAJOBS');
    expect(job.sourcePriority).toBe(PROVIDER_META.usajobs.sourcePriority);
    expect(job.applicantCount).toBeNull();
    expect(job.applyUrl).toBe('https://www.usajobs.gov/GetJob/ViewDetails/21947200?PostingChannelID=RESTAPI');
    expect(job.fromRecruiterBank).toBe(false);
  });

  it('a USAJOBS row has no life from its posting date: it ends on the close date the announcement states', () => {
    expect(NO_DATE_EXPIRY_PROVIDERS).toContain('usajobs');
    // The same close date whatever shape the answer writes it in (an instant at midnight, a local end-of-day time, a bare day).
    for (const value of ['2026-10-19T00:00:00Z', '2026-10-19T23:59:59.9970', '2026-10-19', '2026-10-19T00:00:00.0000']) {
      const job = normalized(inputOf(itemWith({ ApplicationCloseDate: value })));
      expect(job.expiresAt?.toISOString(), value).toBe('2026-10-19T23:59:59.999Z');
    }
    // With no application close date, the last day the announcement is posted is the stated end.
    expect(inputOf(itemWith({ ApplicationCloseDate: '', PositionEndDate: '2026-11-02T00:00:00Z' })).expiresAt).toBe('2026-11-02');
  });

  it('an item with no close date is skipped and counted: it could never be closed', () => {
    expect(usaJobsItemToInput(itemWith({ ApplicationCloseDate: '', PositionEndDate: null }), NOW)).toEqual({ skip: 'usajobs_no_close_date' });
    expect(usaJobsItemToInput(itemWith({ ApplicationCloseDate: 'soon', PositionEndDate: '2026-13-40' }), NOW)).toEqual({ skip: 'usajobs_no_close_date' });
    expect(usaJobsDay('2026-02-30T00:00:00Z')).toBeNull();
    expect(usaJobsDay('1999-12-31')).toBeNull();
    expect(usaJobsDay(20261019)).toBeNull();
  });

  it('the SYNTHETIC item: hourly pay as stated, part-time, two places as listed', () => {
    const input = inputOf(synthetic());
    expect(input).toMatchObject({
      externalId: 'usajobs:900000002',
      company: 'SYNTHETIC Example Bureau',
      locations: ['Washington, District of Columbia', 'Denver, Colorado'],
      location: 'Washington, District of Columbia',
      employmentType: 'Part-Time',
      salaryMin: 21.5,
      salaryMax: 27.95,
      salaryCurrency: 'USD',
      salaryPeriod: 'hour',
      // The row's pay columns are whole numbers: the exact figures travel as the pay text.
      salaryText: '$21.50 - $27.95 Per Hour',
      postedAt: '2026-10-05',
      expiresAt: '2026-10-19',
    });
    const job = normalized(input);
    expect(job.salaryPeriod).toBe('hour');
    expect(job.salaryCurrency).toBe('USD');
    expect([job.salaryMin, job.salaryMax]).toEqual([22, 28]);
    expect(job.salaryText).toBe('$21.50 - $27.95 Per Hour');
    expect(job.salaryDisclosed).toBe(true);
    // A whole-dollar range needs no text beside its figures.
    expect(inputOf(documented()).salaryText).toBeUndefined();
    expect(job.employmentType).toBe('part_time');
    expect(job.locationCountry).toBe('US');
    expect(job.locations.length).toBe(2);
  });

  it('the pay period comes from the documented code or the item\'s own wording, and is never guessed', () => {
    // The one pair the reference documents.
    expect(usaJobsPayPeriod('PA', 'Per Year')).toBe('year');
    expect(usaJobsPayPeriod('PA', '')).toBe('year');
    // Any other interval: the item's own Description, exact phrases only.
    expect(usaJobsPayPeriod('PH', 'Per Hour')).toBe('hour');
    expect(usaJobsPayPeriod('', 'per day')).toBe('day');
    expect(usaJobsPayPeriod('', 'Per  Month')).toBe('month');
    expect(usaJobsPayPeriod('', 'Per Week')).toBe('week');
    // "Bi-weekly" (the code list's documented sample) is not a week; unknown wording is nothing.
    expect(usaJobsPayPeriod('BW', 'Bi-weekly')).toBeNull();
    expect(usaJobsPayPeriod('WC', 'Without Compensation')).toBeNull();
    expect(usaJobsPayPeriod('PH', '')).toBeNull();
    expect(usaJobsPayPeriod('', '')).toBeNull();
    // A code and a wording that disagree: neither is believed.
    expect(usaJobsPayPeriod('PA', 'Per Hour')).toBeNull();
  });

  it('an interval we cannot state gives no figure at all, counted; nothing is converted', () => {
    const mapped = usaJobsItemToInput(itemWith({ PositionRemuneration: [{ MinimumRange: '2400', MaximumRange: '3100', RateIntervalCode: 'BW', Description: 'Bi-weekly' }] }), NOW);
    if ('skip' in mapped) throw new Error(mapped.skip);
    expect(mapped.payUnmapped).toBe(true);
    expect(mapped.input.salaryMin).toBeNull();
    expect(mapped.input.salaryMax).toBeNull();
    expect(mapped.input.salaryPeriod).toBeUndefined();
    expect(mapped.input.salaryText).toBeUndefined();
    const job = normalized(mapped.input);
    expect(job.salaryDisclosed).toBe(false);
    expect(job.salaryMin).toBeNull();
    expect(job.salaryAnnualMin).toBeNull();
  });

  it('pay is only what the remuneration fields state: a figure in the announcement text is never read as this job\'s pay', () => {
    const mapped = usaJobsItemToInput(itemWith({ PositionRemuneration: [], QualificationSummary: 'SYNTHETIC: applicants at the GS-12 level earn $95,000 per year elsewhere.' }), NOW);
    if ('skip' in mapped) throw new Error(mapped.skip);
    expect(mapped.payUnmapped).toBe(false);
    const job = normalized(mapped.input);
    expect(job.descriptionPlain).toContain('$95,000');
    expect(job.salaryDisclosed).toBe(false);
    expect(job.salaryMin).toBeNull();
    // Amounts that are not amounts.
    expect(usaJobsPay([{ MinimumRange: '0', MaximumRange: '0.0', RateIntervalCode: 'PA', Description: 'Per Year' }])).toBeNull();
    expect(usaJobsPay([{ MinimumRange: 'negotiable', MaximumRange: '', RateIntervalCode: 'PA' }])).toBeNull();
    expect(usaJobsPay(null)).toBeNull();
    expect(usaJobsPay([{ MinimumRange: '50,000', MaximumRange: '', RateIntervalCode: 'PA', Description: 'Per Year' }])).toEqual({ min: 50000, max: null, period: 'year', text: null });
    expect(usaJobsPay([{ MinimumRange: '18.25', MaximumRange: '', RateIntervalCode: 'PH', Description: 'Per Hour' }])).toEqual({ min: 18.25, max: null, period: 'hour', text: '$18.25 Per Hour' });
  });

  it('the description is the announcement\'s own text under its headings; how to apply and contact details are never read', () => {
    const input = inputOf(synthetic());
    expect(input.description).toBe(
      [
        'SYNTHETIC job summary: support the bureau\'s program office.',
        'Duties\nSYNTHETIC major duties: keep the office\'s records and schedules.',
        'Qualifications\nSYNTHETIC qualification summary: six months of office support experience.',
        'Requirements\n- SYNTHETIC: U.S. Citizenship is required\n- SYNTHETIC: Must pass a background check\nSYNTHETIC requirements: a background check.',
        'This job is open to\nAgency Employees Only',
      ].join('\n\n'),
    );
    // `MajorDuties` is also served as a list: one duty per line.
    expect(inputOf(itemWith({}, { MajorDuties: ['SYNTHETIC duty one', 'SYNTHETIC duty two'] })).description).toContain('Duties\nSYNTHETIC duty one\nSYNTHETIC duty two');
    // The fixture's `HowToApply` holds a fake name, e-mail address and phone number in both items.
    expect(FIXTURE_TEXT).toContain('fake.person@example.invalid');
    const produced = JSON.stringify([inputOf(documented()), inputOf(synthetic())]);
    for (const leak of ['fake.person@example.invalid', 'Fake Person', '000-555-0100', 'how to apply', '@']) expect(produced, leak).not.toContain(leak);
    // Contact fields a live answer may carry are not read either.
    const withContacts = JSON.stringify(inputOf(itemWith({}, { AgencyContactEmail: 'fake.agency@example.invalid', AgencyContactPhone: '000-555-0199' })));
    expect(withContacts).not.toContain('fake.agency');
    expect(withContacts).not.toContain('000-555-0199');
  });

  it('applies on the official announcement: only an https page of usajobs.gov is a link', () => {
    expect(usaJobsLink('https://www.usajobs.gov/GetJob/ViewDetails/1')).toBe('https://www.usajobs.gov/GetJob/ViewDetails/1');
    expect(usaJobsLink('https://usajobs.gov/job/1')).toBe('https://usajobs.gov/job/1');
    for (const bad of ['http://www.usajobs.gov/job/1', 'https://usajobs.gov.example.invalid/job/1', 'https://example.invalid/usajobs.gov', 'https://user:pw@www.usajobs.gov/job/1', 'javascript:alert(1)', '', null, 42]) {
      expect(usaJobsLink(bad), String(bad)).toBeNull();
    }
    // An apply link on another site is not used: the announcement page is.
    const elsewhere = inputOf(itemWith({ ApplyURI: ['https://apply.example.invalid/start'] }));
    expect(elsewhere.applyUrl).toBe('https://www.usajobs.gov/GetJob/ViewDetails/900000002');
    // `ApplyURI` as a bare string.
    expect(inputOf(itemWith({ ApplyURI: 'https://www.usajobs.gov/GetJob/ViewDetails/900000002?PostingChannelID=RESTAPI' })).applyUrl).toContain('PostingChannelID=RESTAPI');
    // No page at all: skipped, never given an invented link.
    expect(usaJobsItemToInput(itemWith({ ApplyURI: [], PositionURI: '' }), NOW)).toEqual({ skip: 'no_apply_url' });
    expect(usaJobsItemToInput(itemWith({ ApplyURI: ['https://apply.example.invalid/x'], PositionURI: 'https://example.invalid/y' }), NOW)).toEqual({ skip: 'no_apply_url' });
  });

  it('an item without a control number is skipped, never given an invented id', () => {
    for (const id of ['', null, undefined, 'has space', 'x'.repeat(41)]) {
      const item = synthetic();
      item.MatchedObjectId = id;
      expect(usaJobsItemToInput(item, NOW), String(id)).toEqual({ skip: 'no_external_id' });
    }
    // The reference types the control number as a number: both forms give the same id.
    const numeric = synthetic();
    numeric.MatchedObjectId = 900000002;
    expect(inputOf(numeric).externalId).toBe('usajobs:900000002');
    // Never throws on a broken item.
    expect(usaJobsItemToInput({}, NOW)).toEqual({ skip: 'no_external_id' });
    expect(usaJobsItemToInput({ MatchedObjectId: '1', MatchedObjectDescriptor: 'nope' }, NOW)).toEqual({ skip: 'no_apply_url' });
  });

  it('the organisation is the hiring organisation, else its department; several schedules are no single employment type', () => {
    expect(inputOf(itemWith({ OrganizationName: '', DepartmentName: 'SYNTHETIC Example Department' })).company).toBe('SYNTHETIC Example Department');
    expect(inputOf(itemWith({ PositionSchedule: [{ Name: 'Full-Time', Code: '1' }, { Name: 'Part-Time', Code: '2' }] })).employmentType).toBeNull();
    expect(inputOf(itemWith({ PositionSchedule: [] })).employmentType).toBeNull();
    // A schedule our four types do not have stays unset after normalizing.
    expect(normalized(inputOf(itemWith({ PositionSchedule: [{ Name: 'Intermittent', Code: '4' }] }))).employmentType).toBeNull();
    // A location with no country stated: none is assumed.
    const bare = inputOf(itemWith({ PositionLocation: [{ LocationName: 'Anywhere in the U.S. (remote job)' }] }));
    expect(bare.locationCountry).toBeNull();
    expect(inputOf(itemWith({ PositionLocation: [], PositionLocationDisplay: 'Location Negotiable After Selection' })).location).toBe('Location Negotiable After Selection');
  });
});

// ── Who may apply ───────────────────────────────────────────────────────────

describe('usajobs: who may apply, as the item states it', () => {
  it('JI-9: a federal-employees-only posting carries the hiring-path tag with its quote', () => {
    const input = inputOf(synthetic());
    expect(input.marketTags).toEqual([{ tag: USAJOBS_HIRING_PATH_TAG, evidenceQuote: 'Agency Employees Only', evidenceUrl: 'https://www.usajobs.gov/GetJob/ViewDetails/900000002' }]);
    // The same words are in the posting text, where every reader of the job page sees them.
    expect(normalized(input).descriptionPlain).toContain('This job is open to\nAgency Employees Only');
  });

  it('the documented sample is open to United States citizens, in its own words', () => {
    const input = inputOf(documented());
    expect(input.marketTags).toEqual([{ tag: 'usajobs_hiring_path', evidenceQuote: 'United States Citizens', evidenceUrl: 'https://www.usajobs.gov/GetJob/ViewDetails/21947200' }]);
    expect(input.description).toContain('This job is open to\nUnited States Citizens');
  });

  it('reads a HiringPath code list when an answer carries one (not in the documented sample), each code by its documented name', () => {
    // Federal employees only.
    const fed = inputOf(itemWith({}, { WhoMayApply: { Name: '', Code: '' }, HiringPath: ['fed-competitive', 'fed-transition'] }));
    expect(fed.marketTags).toEqual([
      { tag: 'usajobs_hiring_path', evidenceQuote: 'Federal employees - Competitive service; Career transition (CTAP, ICTAP, RPL)', evidenceUrl: 'https://www.usajobs.gov/GetJob/ViewDetails/900000002' },
    ]);
    expect(usaJobsHiringPath({ HiringPath: ['PUBLIC'] })).toBe('Open to the public');
    expect(usaJobsHiringPath({ HiringPath: ['vet', 'mspouse'], WhoMayApply: { Name: 'Status Candidates' } })).toBe('Status Candidates; Veterans; Military spouses');
    // A code the documentation does not list is not named, and nothing is made up for an item that says nothing.
    expect(usaJobsHiringPath({ HiringPath: ['not-a-path'] })).toBeNull();
    expect(usaJobsHiringPath({ WhoMayApply: { Name: '', Code: '' } })).toBeNull();
    expect(usaJobsHiringPath(null)).toBeNull();
    const silent = inputOf(itemWith({}, { WhoMayApply: { Name: '', Code: '' } }));
    expect(silent.marketTags).toBeUndefined();
    expect(silent.description).not.toContain('This job is open to');
    // The seventeen codes of the search reference's HiringPath table.
    expect(Object.keys(USAJOBS_HIRING_PATHS).sort()).toEqual(
      ['disability', 'fed-competitive', 'fed-excepted', 'fed-internal-search', 'fed-transition', 'graduates', 'land', 'mspouse', 'native', 'nguard', 'overseas', 'peace', 'public', 'ses', 'special-authorities', 'student', 'vet'].sort(),
    );
  });

  it('citizenship: the adapter sets no flag of its own; the item\'s statement is in the posting text, verbatim, for the one writer of the flag', () => {
    // Enrichment (jobs/enrich) is the one writer of RAJob.citizenshipRequired, with its quote check. It reads the
    // statement where the adapter puts it: a key requirement under "Requirements", who may apply in the last section.
    const stated = inputOf(synthetic());
    expect(stated.description).toContain('Requirements\n- SYNTHETIC: U.S. Citizenship is required');
    expect(inputOf(documented()).description).toContain('This job is open to\nUnited States Citizens');
    // Never by assumption, and never by a pattern of this adapter: no item gets a citizenship field, whatever it says.
    const eitherOr = inputOf(itemWith({}, { KeyRequirements: ['SYNTHETIC: U.S. citizenship or permanent residency', 'SYNTHETIC: US citizens, nationals or those who owe allegiance to the US'] }));
    const silent = inputOf(itemWith({}, { KeyRequirements: ['SYNTHETIC: Must pass a background check'], WhoMayApply: { Name: 'Agency Employees Only', Code: '15509' } }));
    for (const input of [stated, inputOf(documented()), eitherOr, silent]) {
      expect(Object.keys(input).filter((key) => /citizen/i.test(key))).toEqual([]);
    }
    // An either/or statement stays what it is: text of the posting, word for word.
    expect(eitherOr.description).toContain('- SYNTHETIC: U.S. citizenship or permanent residency\n- SYNTHETIC: US citizens, nationals or those who owe allegiance to the US');
  });
});

// ── The cursor ──────────────────────────────────────────────────────────────

describe('usajobs: the run cursor', () => {
  it('round-trips through JSON and starts with the first run from anything that is not a cursor', () => {
    const cursor: UsaJobsCursor = { v: 1, day: '2026-10-12', page: 3, firstRunDone: true, doneDay: '2026-10-11' };
    expect(parseUsaJobsCursor(formatUsaJobsCursor(cursor))).toEqual(cursor);
    for (const junk of [null, undefined, '', 'not json', '[]', '{"v":2}', '2026-10-12T00:00:00.000Z|abc', '{"v":1,"day":"yesterday","page":-4,"firstRunDone":"yes"}']) {
      expect(parseUsaJobsCursor(junk), String(junk)).toEqual(emptyUsaJobsCursor());
    }
    // A "first run done" with no day it was done on is not believed.
    expect(parseUsaJobsCursor('{"v":1,"day":"2026-10-12","page":0,"firstRunDone":true}').firstRunDone).toBe(false);
    expect(parseUsaJobsCursor(`{"v":1,"day":"2026-10-12","page":${USAJOBS_MAX_PAGE + 5},"firstRunDone":true,"doneDay":"2026-10-11"}`).page).toBe(0);
  });

  it('JI-9: the window is 7 days on the first run and 1 on every daily run after it', () => {
    expect(usaJobsWindowDays({ firstRunDone: false, doneDay: null }, '2026-10-12')).toBe(7);
    expect(usaJobsWindowDays({ firstRunDone: true, doneDay: '2026-10-11' }, '2026-10-12')).toBe(1);
    // A missed day is not lost: the window reaches back to the last finished run, up to the API's 60 days.
    expect(usaJobsWindowDays({ firstRunDone: true, doneDay: '2026-10-09' }, '2026-10-12')).toBe(3);
    expect(usaJobsWindowDays({ firstRunDone: true, doneDay: '2026-01-01' }, '2026-10-12')).toBe(60);
    expect(usaJobsWindowDays({ firstRunDone: true, doneDay: '2026-10-12' }, '2026-10-12')).toBe(1);
  });
});

// ── A run through the adapter ───────────────────────────────────────────────

describe('usajobs: a run through the adapter', () => {
  it('JI-9: the first run asks for 7 days; a 500-item page answers exhausted false and the next fetch asks for page 2', async () => {
    const api = fakeApi((c) => (c.page === '1' ? USAJOBS_PAGE_SIZE : 37));
    const h = harness({ fetch: api.fetch });
    const first = await h.step(NOW);
    expect(first.exhausted).toBe(false);
    expect(first.calls).toBe(1);
    expect(first.jobs.length).toBe(500);
    expect(h.state()).toEqual({ v: 1, day: '2026-10-12', page: 2, firstRunDone: false, doneDay: null });
    const second = await h.step(NOW);
    expect(second.exhausted).toBe(true);
    expect(second.jobs.length).toBe(37);
    expect(api.calls.map((c) => [c.datePosted, c.perPage, c.page])).toEqual([
      ['7', '500', '1'],
      ['7', '500', '2'],
    ]);
    expect(h.state()).toEqual({ v: 1, day: '2026-10-12', page: 0, firstRunDone: true, doneDay: '2026-10-12' });
    // Every posting keeps its own control number.
    expect(new Set([...first.jobs, ...second.jobs].map((j) => j.externalId)).size).toBe(537);
  });

  it('JI-9: after the run nothing is asked until the next UTC day; then one day is asked', async () => {
    const api = fakeApi(() => 3);
    const h = harness({ fetch: api.fetch });
    await h.drain(NOW);
    expect(api.calls.length).toBe(1);
    // Ingest leases the standing query again every half hour: no request is made.
    for (const later of ['2026-10-12T02:30:00Z', '2026-10-12T12:00:00Z', '2026-10-12T23:59:59Z']) {
      expect(await h.step(at(later))).toEqual({ jobs: [], calls: 0, exhausted: true });
    }
    expect(api.calls.length).toBe(1);
    const next = await h.step(at('2026-10-13T00:00:05Z'));
    expect(next.exhausted).toBe(true);
    expect(next.jobs.length).toBe(3);
    expect(api.calls.map((c) => [c.datePosted, c.page])).toEqual([
      ['7', '1'],
      ['1', '1'],
    ]);
    expect(h.state()).toEqual({ v: 1, day: '2026-10-13', page: 0, firstRunDone: true, doneDay: '2026-10-13' });
  });

  it('a daily run pages the same way: one page per fetch, the same one-day window on every page', async () => {
    const api = fakeApi((c) => (Number(c.page) < 3 ? USAJOBS_PAGE_SIZE : 0));
    const h = harness({ fetch: api.fetch, cursor: formatUsaJobsCursor({ v: 1, day: '2026-10-11', page: 0, firstRunDone: true, doneDay: '2026-10-11' }) });
    const results = await h.drain(NOW);
    expect(results.map((r) => [r.jobs.length, r.exhausted])).toEqual([
      [500, false],
      [500, false],
      [0, true],
    ]);
    expect(api.calls.map((c) => [c.datePosted, c.page])).toEqual([
      ['1', '1'],
      ['1', '2'],
      ['1', '3'],
    ]);
  });

  it('a run that did not finish is not lost: the next day starts at page 1 and reaches back to the last finished run', async () => {
    const api = fakeApi((c) => (c.page === '1' ? USAJOBS_PAGE_SIZE : { status: 503 }));
    const h = harness({ fetch: api.fetch, cursor: formatUsaJobsCursor({ v: 1, day: '2026-10-11', page: 0, firstRunDone: true, doneDay: '2026-10-11' }) });
    expect((await h.step(NOW)).exhausted).toBe(false);
    // Page 2 fails: an ingest error, the cursor stays on page 2.
    const failed = await h.step(NOW);
    expect(failed).toEqual({ jobs: [], calls: 1, error: 'usajobs:http_503' });
    expect(h.state().page).toBe(2);
    // The next UTC day: page 1 again, for the two days since the last finished run.
    await h.step(at('2026-10-13T01:00:00Z'));
    expect(api.calls.map((c) => [c.datePosted, c.page])).toEqual([
      ['1', '1'],
      ['1', '2'],
      ['2', '1'],
    ]);
  });

  it('a failed request is an ingest error that stores no cursor; the same page is asked again and the key is never in the error', async () => {
    let fail = true;
    const api = fakeApi(() => (fail ? { status: 401 } : 2));
    const h = harness({ fetch: api.fetch });
    const failed = await h.step(NOW);
    expect(failed).toEqual({ jobs: [], calls: 1, error: 'usajobs:http_401' });
    expect(failed.cursor).toBeUndefined();
    expect(h.cursor).toBeNull();
    expect(JSON.stringify(failed)).not.toContain(KEY);
    fail = false;
    const retried = await h.step(at('2026-10-12T03:00:00Z'));
    expect(retried.jobs.length).toBe(2);
    expect(api.calls.map((c) => [c.datePosted, c.page])).toEqual([
      ['7', '1'],
      ['7', '1'],
    ]);
    // A broken answer does not end a run either.
    const broken = harness({ fetch: fakeApi(() => ({ body: '{"SearchResult":null}' })).fetch });
    expect(await broken.step(NOW)).toEqual({ jobs: [], calls: 1, error: 'usajobs:bad_shape' });
    expect(broken.cursor).toBeNull();
  });

  it('a run stops at the API\'s 10,000 rows a query and says so', async () => {
    const api = fakeApi(() => USAJOBS_PAGE_SIZE);
    const h = harness({ fetch: api.fetch, cursor: formatUsaJobsCursor({ v: 1, day: '2026-10-12', page: USAJOBS_MAX_PAGE, firstRunDone: false, doneDay: null }) });
    const last = await h.step(NOW);
    expect(USAJOBS_MAX_PAGE).toBe(20);
    expect(api.calls.map((c) => c.page)).toEqual(['20']);
    expect(last.exhausted).toBe(true);
    expect(last.notes).toEqual({ usajobs_row_cap: 1 });
    expect(h.state()).toEqual({ v: 1, day: '2026-10-12', page: 0, firstRunDone: true, doneDay: '2026-10-12' });
  });

  it('counts what it skips, by reason, and never returns a posting without an id, a link or a close date', async () => {
    const items = [synthetic(), itemWith({ ApplicationCloseDate: '', PositionEndDate: '' }, {}, '900000101'), itemWith({ ApplyURI: [], PositionURI: '' }, {}, '900000102'), itemWith({}, {}, ''), itemWith({ PositionRemuneration: [{ MinimumRange: '900', MaximumRange: '1200', RateIntervalCode: 'BW', Description: 'Bi-weekly' }] }, {}, '900000103')];
    const api = fakeApi(() => ({ body: JSON.stringify({ SearchResult: { SearchResultItems: items } }) }));
    const result = await harness({ fetch: api.fetch }).step(NOW);
    expect(result.jobs.map((j) => j.externalId)).toEqual(['usajobs:900000002', 'usajobs:900000103']);
    expect(result.notes).toEqual({ usajobs_no_close_date: 1, no_apply_url: 1, no_external_id: 1, usajobs_pay_interval_unmapped: 1 });
    for (const job of result.jobs) {
      expect(job.applyUrl).toMatch(/^https:\/\/www\.usajobs\.gov\//);
      expect(job.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('waits for the next tick when the time left cannot hold a request: not done, nothing asked', async () => {
    const api = fakeApi(() => 2);
    const h = harness({ fetch: api.fetch });
    expect(await h.step(NOW, { budgetMs: USAJOBS_MIN_BUDGET_MS - 1 })).toEqual({ jobs: [], calls: 0, exhausted: false });
    const aborted = new AbortController();
    aborted.abort();
    expect(await h.step(NOW, { signal: aborted.signal })).toEqual({ jobs: [], calls: 0, exhausted: false });
    expect(api.calls).toEqual([]);
    expect(h.cursor).toBeNull();
    expect((await h.step(NOW, { budgetMs: USAJOBS_MIN_BUDGET_MS })).jobs.length).toBe(2);
  });

  it('never fetches for another market, and never throws', async () => {
    const api = fakeApi(() => 2);
    const adapter = createUsaJobsAdapter({ env: ENV, fetch: api.fetch });
    expect(await adapter.fetch(query(null, 'cn'), { now: NOW })).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect(api.calls).toEqual([]);
    const boom = createUsaJobsAdapter({
      env: ENV,
      fetch: () => {
        throw new Error('boom');
      },
    });
    expect(await boom.fetch(query(), { now: NOW })).toEqual({ jobs: [], calls: 1, error: 'usajobs:network' });
  });
});

// ── Registration ────────────────────────────────────────────────────────────

describe('usajobs: registration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is registered once, next to the Taiwan open-data source', () => {
    expect(getSourceAdapter('usajobs')).toBe(usaJobsAdapter);
    ensureUsaJobsAdapter();
    ensureUsaJobsAdapter();
    expect(registeredSourceAdapters().filter((a) => a.provider === 'usajobs')).toEqual([usaJobsAdapter]);
    expect(jobSourceKind('usajobs')).toBe('search');
    expect(jobSourceTransport('usajobs')).toBe('api');
  });

  it('JI-9: RoboApply\'s ingest has the adapter, off with reason no_key until the key exists; GoApply\'s never has it', () => {
    // The registered adapter reads the process environment: here, one with no USAJOBS variable.
    for (const name of ['USAJOBS_API_KEY', 'USAJOBS_USER_AGENT_EMAIL', 'USAJOBS_DISABLED']) vi.stubEnv(name, '');
    const robo = adaptersForBrand(getBrand('roboapply'), {});
    expect(robo.filter((a) => a.provider === 'usajobs')).toEqual([usaJobsAdapter]);
    expect(listEnabledAdaptersFor(getBrand('roboapply'), {}).map((a) => a.provider)).not.toContain('usajobs');
    const described = sourcesForBrand(getBrand('roboapply'), {}).find((s) => s.provider === 'usajobs')!;
    expect(described.status()).toEqual({ enabled: false, transport: 'api', reason: 'no_key' });
    expect(described.costModel).toBe('free');
    expect(described.sourceBoards).toEqual(['usajobs']);
    // With the key and its address it is on, for RoboApply only; the switch turns it off again.
    vi.stubEnv('USAJOBS_API_KEY', KEY);
    vi.stubEnv('USAJOBS_USER_AGENT_EMAIL', EMAIL);
    expect(described.status()).toEqual({ enabled: true, transport: 'api', reason: null });
    expect(listEnabledAdaptersFor(getBrand('roboapply'), {}).map((a) => a.provider)).toContain('usajobs');
    expect(listEnabledAdaptersFor(getBrand('goapply'), {}).map((a) => a.provider)).not.toContain('usajobs');
    vi.stubEnv('USAJOBS_DISABLED', 'true');
    expect(described.status()).toEqual({ enabled: false, transport: 'api', reason: 'disabled' });
    const go = adaptersForBrand(getBrand('goapply'), {});
    expect(go.map((a) => a.provider)).not.toContain('usajobs');
    expect(adaptersForBrand(getBrand('goapply'), { JOB_PROVIDERS_GOAPPLY: 'usajobs,bank_gohire' }).map((a) => a.provider)).not.toContain('usajobs');
    // RoboApply can narrow it away like any other source.
    expect(adaptersForBrand(getBrand('roboapply'), { JOB_PROVIDERS_ROBOAPPLY: 'bank_robohire' }).map((a) => a.provider)).not.toContain('usajobs');
  });

  it('public display stays the owner\'s decision: off by default, on only when PUBLIC_DISPLAY_PROVIDERS names the source', () => {
    expect(normalized(inputOf(synthetic())).publicDisplay).toBe(false);
    expect(normalized(inputOf(synthetic()), ['usajobs']).publicDisplay).toBe(true);
  });
});
