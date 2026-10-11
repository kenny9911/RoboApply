// @vitest-environment node
//
// 事求人 adapter (MKT-5D; JT-9): the request, the reader that never takes the
// two contact elements, the field mapping, Republic-of-China dates, who may
// apply (PERSON_KIND), the privacy scan, one read a day and closure by the
// complete listing. Nothing here reaches the network or a database: the
// endpoint is a scripted fake, every record is SYNTHETIC, the clock is fixed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBrand } from '../../../platform/brand/index.js';
import { CREDIT_LINE_BOARDS } from '../../feed/sourceLine.js';
import type { IngestDb } from '../ingest/db.js';
import { adaptersForBrand, listEnabledAdaptersFor, sourcesForBrand } from '../ingest/providers.js';
import { archiveUnlistedJobs } from '../ingest/upsert.js';
import { afterNormalize, cardMeta, type MarketHookJob } from '../marketHooks.js';
import { NO_DATE_EXPIRY_PROVIDERS, PROVIDER_META, asMarketHookJob, normalizeProviderJob } from '../normalize/index.js';
import { adapterCostModel, getSourceAdapter, jobSourceKind, jobSourceTransport, registeredSourceAdapters, sourceUserAgent, type SourceFetchResult, type SourceQuery } from './index.js';
import { ensureTwGovJobsAdapter, twGovJobsAdapter, twOpenDataAdapter } from './register.js';
import {
  TW_GOV_JOBS_DATASET,
  TW_GOV_JOBS_DEFAULT_URL,
  TW_GOV_JOBS_MAX_BYTES,
  TW_GOV_JOBS_MAX_RECORD_CHARS,
  TW_GOV_JOBS_MIN_BUDGET_MS,
  TW_GOV_NEVER_READ,
  TW_GOV_PERSON_KIND_TAG,
  TW_GOV_PUBLIC_KINDS,
  TW_GOV_READ_FIELDS,
  createTwGovJobsAdapter,
  formatTwGovCursor,
  parseTwGovCursor,
  parseTwGovXml,
  requestTwGovJobs,
  rocDate,
  taipeiDay,
  twGovJobsIncludeTransfers,
  twGovJobsStatus,
  twGovJobsUrl,
  twGovPlaces,
  twGovRowToInput,
  twGovVacancyLink,
  withoutContactDetails,
  type TwGovFetchLike,
  type TwGovJobsInput,
  type TwGovRow,
} from './twGovJobs.js';
import { TW_OGDL_LICENCE_URL, TW_OPEN_DATA_ATTRIBUTIONS, TW_OPEN_DATA_SOURCE_NAMES } from './twHooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, '__fixtures__', 'twgov', 'sample.xml'), 'utf8');
/** 2026-10-12 12:00 in Taipei. */
const NOW = new Date('2026-10-12T04:00:00.000Z');

// ── Helpers ─────────────────────────────────────────────────────────────────

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The 26 elements of a record, in the file's order. */
const ORDER = [
  'ORG_ID', 'ORG_NAME', 'PERSON_KIND', 'RANK', 'TITLE', 'SYSNAM', 'NUMBER_OF', 'RESERVE_NUM', 'GENDER_TYPE', 'WORK_PLACE_TYPE', 'DATE_FROM', 'DATE_TO', 'IS_HANDICAP', 'IS_ORIGINAL',
  'IS_LOCAL_ORIGINAL', 'IS_TRANING', 'TYPE', 'VITAE_EMAIL', 'WORK_QUALITY', 'WORK_ITEM', 'WORK_ADDRESS', 'CONTACT_METHOD', 'URL_LINK', 'VIEW_URL', 'Work_Type', 'IS_TRANSFER',
] as const;

type Spec = Partial<Record<(typeof ORDER)[number], string | null>>;

const BASE: Record<string, string> = {
  ORG_ID: '900000009Z',
  ORG_NAME: '範例機關',
  PERSON_KIND: '約僱人員',
  RANK: '',
  TITLE: 'SYNTHETIC 範例職缺',
  SYSNAM: '無',
  NUMBER_OF: '1',
  RESERVE_NUM: '',
  GENDER_TYPE: '不拘',
  WORK_PLACE_TYPE: ',10-臺北市',
  DATE_FROM: '1151001',
  DATE_TO: '1151231',
  IS_HANDICAP: 'Y',
  IS_ORIGINAL: 'Y',
  IS_LOCAL_ORIGINAL: 'N',
  IS_TRANING: 'N',
  TYPE: '其他',
  VITAE_EMAIL: 'fake.contact@example.invalid',
  WORK_QUALITY: 'SYNTHETIC 資格條件',
  WORK_ITEM: 'SYNTHETIC 工作項目',
  WORK_ADDRESS: '臺北市中正區範例路9號',
  CONTACT_METHOD: 'SYNTHETIC 聯絡人：假名先生 (00)5550-0155',
  URL_LINK: '',
  Work_Type: '3',
  IS_TRANSFER: 'N',
};

/** One SYNTHETIC `<ROW>`; a null value leaves the element out, an empty one writes `<NAME />`. */
function record(id: number | string, over: Spec = {}): string {
  const values: Record<string, string | null> = { ...BASE, VIEW_URL: `https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=${id}`, ...over };
  const body = ORDER.map((name) => {
    const value = values[name];
    if (value === null || value === undefined) return '';
    return value === '' ? `<${name} />` : `<${name}>${esc(value)}</${name}>`;
  }).join('');
  return `<ROW>${body}</ROW>`;
}

const documentOf = (rows: readonly string[]): string => `<?xml version="1.0" encoding="utf-8"?><ROOT><ANNOUNCE_DATE>1151012</ANNOUNCE_DATE>${rows.join('')}</ROOT>`;

function fixtureRows(): TwGovRow[] {
  const doc = parseTwGovXml(FIXTURE);
  if (!doc.ok) throw new Error(doc.error);
  return doc.rows;
}

function rowsOf(xml: string): TwGovRow[] {
  const doc = parseTwGovXml(xml);
  if (!doc.ok) throw new Error(doc.error);
  return doc.rows;
}

function inputOf(row: TwGovRow, options: { includeTransfers?: boolean } = {}): TwGovJobsInput {
  const mapped = twGovRowToInput(row, NOW, options);
  if ('skip' in mapped) throw new Error(`the record was skipped: ${mapped.skip}`);
  return mapped.input;
}

const rowOf = (over: Spec = {}, id: number | string = 9000000099): TwGovRow => rowsOf(documentOf([record(id, over)]))[0]!;

const normalized = (input: TwGovJobsInput, publicDisplayProviders: string[] = []) => normalizeProviderJob(input, 'tw_gov_jobs', { market: 'intl', now: NOW, publicDisplayProviders });

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

type Script = (call: Call) => { status: number } | { body: string } | { throws: Error };

function fakeEndpoint(script: Script) {
  const calls: Call[] = [];
  const fetch: TwGovFetchLike = async (url, init) => {
    const call: Call = { url, headers: init.headers ?? {}, redirect: init.redirect };
    calls.push(call);
    const answer = script(call);
    if ('throws' in answer) throw answer.throws;
    if ('status' in answer) return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => '' };
    return { ok: true, status: 200, text: async () => answer.body };
  };
  return { fetch, calls };
}

const query = (cursor?: string | null, market: SourceQuery['market'] = 'intl'): SourceQuery => ({
  id: 'q-twgov',
  provider: 'tw_gov_jobs',
  market,
  origin: 'bank_sync',
  params: { q: '', country: '*', datePosted: 'all', ...(cursor ? { cursor } : {}) },
});

interface Harness {
  adapter: ReturnType<typeof createTwGovJobsAdapter>;
  cursor: string | null;
  /** One fetch at `now`; the stored cursor follows what ingest would write. */
  step(now: Date, ctx?: { budgetMs?: number; signal?: AbortSignal }): Promise<SourceFetchResult>;
}

function harness(deps: Parameters<typeof createTwGovJobsAdapter>[0] & { cursor?: string | null }): Harness {
  const adapter = createTwGovJobsAdapter({ env: {}, ...deps });
  const h: Harness = {
    adapter,
    cursor: deps.cursor ?? null,
    async step(now, ctx = {}) {
      const result = await adapter.fetch(query(h.cursor), { now, ...ctx });
      // Ingest stores a cursor only for a result without an error (pipeline.ts `runIngestQuery`).
      if (!result.error && result.cursor) h.cursor = result.cursor;
      return result;
    },
  };
  return h;
}

const at = (iso: string) => new Date(iso);
const ids = (result: SourceFetchResult) => result.jobs.map((j) => j.externalId);

/** The open rows of a board, as the listing diff reads and archives them (ingest/upsert.ts `archiveUnlistedJobs`). */
function openRowsDb(externalIds: string[]) {
  const rows = externalIds.map((externalId) => ({ externalId, sourceBoard: 'tw_gov_jobs', market: 'intl', visibility: 'public', archivedAt: null as Date | null, closeReason: null as string | null }));
  const db = {
    rAJob: {
      findMany: async (args: { where: { market: string; sourceBoard: string } }) => rows.filter((r) => r.market === args.where.market && r.sourceBoard === args.where.sourceBoard && r.archivedAt === null).map((r) => ({ externalId: r.externalId })),
      updateMany: async (args: { where: { sourceBoard: string; externalId: { in: string[] } }; data: { archivedAt: Date; closeReason: string } }) => {
        const hit = rows.filter((r) => r.sourceBoard === args.where.sourceBoard && args.where.externalId.in.includes(r.externalId) && r.archivedAt === null);
        for (const r of hit) {
          r.archivedAt = args.data.archivedAt;
          r.closeReason = args.data.closeReason;
        }
        return { count: hit.length };
      },
    },
  };
  return { db: db as unknown as IngestDb, rows };
}

// ── Switches ────────────────────────────────────────────────────────────────

describe('tw_gov_jobs: on by default, off by one switch', () => {
  it('is on with nothing set (OGDL v1) and reads the dataset\'s own address', () => {
    expect(twGovJobsStatus({})).toEqual({ enabled: true });
    expect(twGovJobsUrl({})).toBe(TW_GOV_JOBS_DEFAULT_URL);
    expect(TW_GOV_JOBS_DEFAULT_URL).toBe('https://web3.dgpa.gov.tw/WANT03FRONT/AP/WANTF00003.aspx?GETJOB=Y');
    expect(TW_GOV_JOBS_DATASET).toMatchObject({ id: 7229, name: '行政院人事行政總處事求人機關徵才資料', provider: '行政院人事行政總處', licenceUrl: 'https://data.gov.tw/license' });
    for (const value of ['true', '1', 'on', '', '  ']) expect(twGovJobsStatus({ TW_GOV_JOBS_ENABLED: value }).enabled).toBe(true);
  });

  it('with the switch off the adapter reports disabled and fetches nothing', async () => {
    for (const value of ['false', 'FALSE', '0', 'off', 'no']) expect(twGovJobsStatus({ TW_GOV_JOBS_ENABLED: value })).toEqual({ enabled: false, reason: 'kill_switch' });
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const adapter = createTwGovJobsAdapter({ env: { TW_GOV_JOBS_ENABLED: 'false' }, fetch: endpoint.fetch });
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.disabledReason?.()).toBe('kill_switch');
    expect(await adapter.fetch(query(), { now: NOW })).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect(endpoint.calls).toEqual([]);
  });

  it('accepts only an https address on dgpa.gov.tw', async () => {
    expect(twGovJobsUrl({ TW_GOV_JOBS_URL: 'https://web9.dgpa.gov.tw/other/path.aspx?GETJOB=Y' })).toBe('https://web9.dgpa.gov.tw/other/path.aspx?GETJOB=Y');
    for (const bad of ['http://web3.dgpa.gov.tw/x', 'https://dgpa.gov.tw.example.invalid/x', 'https://example.invalid/dgpa.gov.tw', 'https://user:pw@web3.dgpa.gov.tw/x', 'not a url', 'file:///etc/hosts']) {
      expect(twGovJobsUrl({ TW_GOV_JOBS_URL: bad }), bad).toBeNull();
      expect(twGovJobsStatus({ TW_GOV_JOBS_URL: bad })).toEqual({ enabled: false, reason: 'url_invalid' });
    }
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    expect(await requestTwGovJobs({ env: { TW_GOV_JOBS_URL: 'https://example.invalid/x' }, fetch: endpoint.fetch })).toEqual({ ok: false, error: 'url_invalid' });
    expect(endpoint.calls).toEqual([]);
  });

  it('describes itself: a free cursor source of the international market, Taiwan only, not metered', () => {
    const adapter = createTwGovJobsAdapter({ env: {} });
    expect(adapter).toMatchObject({ provider: 'tw_gov_jobs', kind: 'cursor', markets: ['intl'], costModel: 'free', sourceBoards: ['tw_gov_jobs'] });
    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.disabledReason?.()).toBeNull();
    expect(adapter.transport?.()).toBe('api');
    expect(adapter.dailyCallLimit()).toBeNull();
    expect(adapterCostModel(adapter)).toBe('free');
    expect(adapter.supportsCountry('TW')).toBe(true);
    expect(adapter.supportsCountry('tw')).toBe(true);
    for (const country of ['US', 'CN', 'HK', '*', '']) expect(adapter.supportsCountry(country)).toBe(false);
    expect(adapter.ownRun).toBeUndefined();
  });

  it('TW_GOV_JOBS_INCLUDE_TRANSFERS is off unless it says true', () => {
    expect(twGovJobsIncludeTransfers({})).toBe(false);
    for (const value of ['false', '0', '', 'maybe']) expect(twGovJobsIncludeTransfers({ TW_GOV_JOBS_INCLUDE_TRANSFERS: value })).toBe(false);
    for (const value of ['true', 'TRUE', '1', 'on', 'yes']) expect(twGovJobsIncludeTransfers({ TW_GOV_JOBS_INCLUDE_TRANSFERS: value })).toBe(true);
  });
});

// ── One request ─────────────────────────────────────────────────────────────

describe('tw_gov_jobs: one request', () => {
  it('reads the file with the identifying User-Agent and never follows a redirect', async () => {
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const env = { JOB_SOURCES_CONTACT: 'mailto:jobs-contact@example.invalid' };
    const doc = await requestTwGovJobs({ env, fetch: endpoint.fetch });
    expect(doc.ok && doc.rows.length).toBe(3);
    const call = endpoint.calls[0]!;
    expect(call.url).toBe(TW_GOV_JOBS_DEFAULT_URL);
    expect(call.headers['User-Agent']).toBe(sourceUserAgent('intl', env));
    expect(call.headers['User-Agent']).toBe('RoboApplyJobs/1.0 (+mailto:jobs-contact@example.invalid)');
    expect(call.redirect).toBe('error');
  });

  it('a failed answer is a short error code', async () => {
    const codes: string[] = [];
    for (const script of [
      () => ({ status: 404 }),
      () => ({ status: 503 }),
      () => ({ status: 302 }),
      () => ({ throws: new TypeError('fetch failed', { cause: new Error('unexpected redirect') }) }),
      () => ({ throws: new Error('connect ECONNREFUSED') }),
      () => ({ body: '<html><body>Service unavailable</body></html>' }),
      () => ({ body: '' }),
    ] as Script[]) {
      const doc = await requestTwGovJobs({ env: {}, fetch: fakeEndpoint(script).fetch });
      expect(doc.ok).toBe(false);
      if (!doc.ok) codes.push(doc.error);
    }
    expect(codes).toEqual(['http_404', 'http_503', 'redirect', 'redirect', 'network', 'not_xml', 'empty']);
  });

  it('refuses an oversized body, by its declared length or by what arrived', async () => {
    const declared: TwGovFetchLike = async () => ({ ok: true, status: 200, headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(TW_GOV_JOBS_MAX_BYTES + 1) : null) }, text: async () => FIXTURE });
    expect(await requestTwGovJobs({ env: {}, fetch: declared })).toEqual({ ok: false, error: 'response_too_large' });
    const arrived: TwGovFetchLike = async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(TW_GOV_JOBS_MAX_BYTES + 1) });
    expect(await requestTwGovJobs({ env: {}, fetch: arrived })).toEqual({ ok: false, error: 'response_too_large' });
    expect(TW_GOV_JOBS_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  it('gives up after its timeout and when the caller aborts', async () => {
    const hang: TwGovFetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await requestTwGovJobs({ env: {}, fetch: hang, timeoutMs: 5 })).toEqual({ ok: false, error: 'timeout' });
    const controller = new AbortController();
    const pending = requestTwGovJobs({ env: {}, fetch: hang, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
  });
});

// ── The reader ──────────────────────────────────────────────────────────────

describe('tw_gov_jobs: the element reader', () => {
  it('JT-9: a record holds only the wanted elements; the two contact elements are never read into it', () => {
    const rows = fixtureRows();
    expect(rows.length).toBe(3);
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(TW_GOV_READ_FIELDS as readonly string[]).toContain(key);
      expect(row).not.toHaveProperty('VITAE_EMAIL');
      expect(row).not.toHaveProperty('CONTACT_METHOD');
    }
    expect(TW_GOV_NEVER_READ).toEqual(['VITAE_EMAIL', 'CONTACT_METHOD']);
    for (const never of TW_GOV_NEVER_READ) expect(TW_GOV_READ_FIELDS as readonly string[]).not.toContain(never);
    // The fixture does hold both elements, with fake values, so the absence above proves the drop.
    expect(FIXTURE).toContain('<VITAE_EMAIL>fake.contact@example.invalid</VITAE_EMAIL>');
    expect(FIXTURE).toContain('<CONTACT_METHOD>');
    expect(JSON.stringify(rows)).not.toContain('fake.contact');
    expect(JSON.stringify(rows)).not.toContain('假名');
  });

  it('reads the fixture\'s first record as written, with entities decoded', () => {
    const [first, , third] = fixtureRows();
    expect(first).toMatchObject({
      ORG_NAME: '範例市政府範例局',
      PERSON_KIND: '約僱人員',
      TITLE: 'SYNTHETIC 約僱行政助理',
      NUMBER_OF: '2',
      WORK_PLACE_TYPE: ',10-臺北市',
      DATE_FROM: '1151001',
      DATE_TO: '1151231',
      WORK_ADDRESS: '臺北市中正區範例路1號',
      VIEW_URL: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000001',
    });
    expect(first!.WORK_QUALITY).toContain('熟悉文書處理軟體 & 試算表。');
    expect(third!.WORK_QUALITY).toContain('工作經驗 > 1 年者佳');
    expect(third!.WORK_ITEM).toContain('<專案期間一年>');
  });

  it('is tolerant of layout: whitespace between elements, element names in any case, CDATA, numeric references, empty and missing elements', () => {
    const pretty = `﻿<?xml version="1.0" encoding="utf-8"?>
<ROOT>
  <ANNOUNCE_DATE>1151012</ANNOUNCE_DATE>
  <ROW >
    <org_name>範例機關</org_name>
    <Title><![CDATA[SYNTHETIC <A&B> 職缺]]></Title>
    <PERSON_KIND>約僱人員</PERSON_KIND>
    <NUMBER_OF />
    <WORK_ITEM>甲&#x3001;乙&#12289;丙 &quot;丁&quot; &apos;戊&apos; &#0; &#xD800; &unknown;</WORK_ITEM>
    <VITAE_EMAIL>fake.contact@example.invalid</VITAE_EMAIL>
    <VIEW_URL>https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000050</VIEW_URL>
    <TITLE>a second title is ignored</TITLE>
  </ROW>
</ROOT>
`;
    const [row] = rowsOf(pretty);
    expect(row).toEqual({
      ORG_NAME: '範例機關',
      TITLE: 'SYNTHETIC <A&B> 職缺',
      PERSON_KIND: '約僱人員',
      NUMBER_OF: '',
      WORK_ITEM: '甲、乙、丙 "丁" \'戊\'   &unknown;',
      VIEW_URL: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000050',
    });
    // A missing element is absent, never an invented value.
    expect(row!.DATE_TO).toBeUndefined();
    // Attributes (the live file has none) are passed over; the two contact elements stay out with or without them.
    const attributed = `<ROOT><ROW id="1"><TITLE lang="zh-TW">SYNTHETIC 職缺</TITLE><NUMBER_OF nil="true" /><VITAE_EMAIL kind="a">fake.contact@example.invalid</VITAE_EMAIL><VIEW_URL rel="self">https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000051</VIEW_URL></ROW><ROW /></ROOT>`;
    expect(rowsOf(attributed)).toEqual([{ TITLE: 'SYNTHETIC 職缺', NUMBER_OF: '', VIEW_URL: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000051' }]);
  });

  it('takes the document whole or not at all: a cut-off or malformed answer is an error, and so is an empty listing', () => {
    const whole = documentOf([record(1), record(2)]);
    expect(rowsOf(whole).length).toBe(2);
    // Cut in the middle of the second record, and cut after it but before the closing root.
    expect(parseTwGovXml(whole.slice(0, whole.lastIndexOf('<WORK_ITEM>')))).toEqual({ ok: false, error: 'truncated' });
    expect(parseTwGovXml(whole.replace('</ROOT>', ''))).toEqual({ ok: false, error: 'truncated' });
    expect(parseTwGovXml(`${whole.slice(0, whole.lastIndexOf('</ROW>'))}</ROOT>`)).toEqual({ ok: false, error: 'truncated' });
    // A record that never closes swallows the next one: malformed, not a shorter listing.
    expect(parseTwGovXml(whole.replace('</ROW><ROW>', '<ROW>'))).toEqual({ ok: false, error: 'malformed' });
    expect(parseTwGovXml(documentOf([]))).toEqual({ ok: false, error: 'empty_listing' });
    // A record of an impossible size is refused with the whole document.
    expect(parseTwGovXml(documentOf([record(1), record(2, { WORK_ITEM: 'x'.repeat(TW_GOV_JOBS_MAX_RECORD_CHARS) })]))).toEqual({ ok: false, error: 'malformed' });
    expect(parseTwGovXml('{"not":"xml"}')).toEqual({ ok: false, error: 'not_xml' });
    expect(parseTwGovXml('   ')).toEqual({ ok: false, error: 'empty' });
    expect(parseTwGovXml(undefined as unknown as string)).toEqual({ ok: false, error: 'not_xml' });
  });
});

// ── Mapping ─────────────────────────────────────────────────────────────────

describe('tw_gov_jobs: a record becomes a posting', () => {
  it('JT-9: maps the first fixture record field by field', () => {
    const mapped = twGovRowToInput(fixtureRows()[0]!, NOW);
    if ('skip' in mapped) throw new Error(mapped.skip);
    expect(mapped.input).toEqual({
      externalId: 'dgpa:9000000001',
      sourceBoard: 'tw_gov_jobs',
      title: 'SYNTHETIC 約僱行政助理',
      company: '範例市政府範例局',
      description: [
        '人員區分：約僱人員',
        '工作項目：\nSYNTHETIC 工作項目：一般行政及文書處理。\n其他臨時交辦事項。',
        '資格條件：\nSYNTHETIC 資格條件：\n(一)\t高中（職）以上畢業。\n(二)\t熟悉文書處理軟體 & 試算表。\n(三)\t酬金依約僱人員酬金表辦理。',
      ].join('\n\n'),
      applyUrl: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000001',
      sourceUrl: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000001',
      sourcePublisher: '事求人',
      location: '臺北市中正區範例路1號',
      locations: ['臺北市'],
      locationCountry: 'TW',
      locationDistrict: '中正區',
      postedAt: '2026-10-01',
      fetchedAt: NOW,
      expiresAt: '2026-12-31',
      headcount: 2,
    });
    // The sentence of 工作項目 that held an e-mail address and a phone number is gone, and counted.
    expect(mapped.contactRemoved).toBe(true);
  });

  it('JT-9: rows link to VIEW_URL, and DATE_TO 1151231 becomes 2026-12-31, the end of that day in Taipei', () => {
    const job = normalized(inputOf(fixtureRows()[0]!));
    expect(job.applyUrl).toBe('https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000001');
    expect(job.sourceUrl).toBe(job.applyUrl);
    expect(job.expiresAt?.toISOString()).toBe('2026-12-31T15:59:59.999Z');
    // DATE_FROM 1151001 is the first instant of 2026-10-01 in Taipei.
    expect(job.postedAt?.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(job.postedAtEstimated).toBe(false);
    expect(job.market).toBe('intl');
    expect(job.locationCountry).toBe('TW');
    expect(job.locationDistrict).toBe('中正區');
    expect(job.location).toBe('臺北市中正區範例路1號');
    expect(job.headcount).toBe(2);
    expect(job.sourceBoard).toBe('tw_gov_jobs');
    expect(job.sourcePriority).toBe(PROVIDER_META.tw_gov_jobs.sourcePriority);
    expect(job.applicantCount).toBeNull();
    expect(job.fromRecruiterBank).toBe(false);
    expect(job.companyName).toBe('範例市政府範例局');
  });

  it('Republic-of-China dates: year + 1911; anything that is not a real date is no date', () => {
    expect(rocDate('1151231')).toBe('2026-12-31');
    expect(rocDate('1130306')).toBe('2024-03-06');
    expect(rocDate('990101')).toBe('2010-01-01');
    expect(rocDate(' 1151012 ')).toBe('2026-10-12');
    expect(rocDate('１１５１２３１')).toBe('2026-12-31');
    // The file's "no end date".
    expect(rocDate('9991231')).toBeNull();
    for (const bad of ['1150230', '1151301', '20261231', '115-12-31', '額滿為止', '', '0000101', null, undefined]) expect(rocDate(bad as string), String(bad)).toBeNull();
  });

  it('a record with no end date states no deadline, and never gets one from its age', () => {
    const input = inputOf(rowOf({ DATE_TO: '9991231' }));
    expect(input.expiresAt).toBeNull();
    expect(normalized(input).expiresAt).toBeNull();
    expect(NO_DATE_EXPIRY_PROVIDERS).toContain('tw_gov_jobs');
    // A posting from 2024 that the file still lists is ingested (JI-10: never dropped for posting age).
    const old = normalized(inputOf(rowOf({ DATE_FROM: '1130306', DATE_TO: '9991231' })));
    expect(old.postedAt?.toISOString()).toBe('2024-03-05T16:00:00.000Z');
    expect(old.expiresAt).toBeNull();
    // An unreadable start date is an estimate, marked as one.
    expect(normalized(inputOf(rowOf({ DATE_FROM: 'n/a' }))).postedAtEstimated).toBe(true);
  });

  it('the place: the listed counties without their numeric prefix, and the address when it is one', () => {
    expect(twGovPlaces(',10-臺北市')).toEqual(['臺北市']);
    expect(twGovPlaces(',60-嘉義市,61-嘉義縣')).toEqual(['嘉義市', '嘉義縣']);
    expect(twGovPlaces('10-臺北市')).toEqual(['臺北市']);
    expect(twGovPlaces(',99-跨縣市')).toEqual([]);
    expect(twGovPlaces(',10-臺北市,10-臺北市,')).toEqual(['臺北市']);
    expect(twGovPlaces('')).toEqual([]);
    expect(twGovPlaces(null)).toEqual([]);

    // An address that names its county stands alone; another one follows the first listed place.
    expect(inputOf(rowOf({ WORK_ADDRESS: '本府行政大樓3樓' }))).toMatchObject({ location: '臺北市 本府行政大樓3樓', locations: ['臺北市'], locationDistrict: null });
    // A postal code written before the county is left out, so the county is not repeated and the district is read.
    for (const coded of ['100006 臺北市中正區範例路1號', '100臺北市中正區範例路1號', '10048 臺北市中正區範例路1號', '(100)臺北市中正區範例路1號', '（100006）臺北市中正區範例路1號', '１００ 臺北市中正區範例路1號', '100-06 臺北市中正區範例路1號']) {
      expect(inputOf(rowOf({ WORK_ADDRESS: coded })), coded).toMatchObject({ location: '臺北市中正區範例路1號', locationDistrict: '中正區' });
    }
    expect(normalized(inputOf(rowOf({ WORK_ADDRESS: '100006 臺北市中正區範例路1號' })))).toMatchObject({ location: '臺北市中正區範例路1號', locationDistrict: '中正區', locationCountry: 'TW' });
    // Digits that no county follows are part of the address and stay.
    expect(inputOf(rowOf({ WORK_ADDRESS: '300號大樓3樓' })).location).toBe('臺北市 300號大樓3樓');
    expect(inputOf(rowOf({ WORK_ADDRESS: '407 西屯區範例路9號' })).location).toBe('臺北市 407 西屯區範例路9號');
    // Two listed counties: both are kept, the address is the shown place.
    const two = inputOf(fixtureRows()[1]!, { includeTransfers: true });
    expect(two).toMatchObject({ location: '嘉義縣太保市範例路2號', locations: ['嘉義市', '嘉義縣'], locationDistrict: '太保市' });
    // No address, or a cell that is directions and not an address: the listed place alone.
    expect(inputOf(rowOf({ WORK_ADDRESS: '' })).location).toBe('臺北市');
    expect(inputOf(rowOf({ WORK_ADDRESS: `本機關${'很長的說明'.repeat(30)}` })).location).toBe('臺北市');
    // Nothing listed and no address: no place is made up.
    const nowhere = inputOf(rowOf({ WORK_PLACE_TYPE: ',99-跨縣市', WORK_ADDRESS: '' }));
    expect(nowhere.location).toBeNull();
    expect(nowhere.locations).toBeNull();
    // The county of the first fixture record resolves to Taipei in Taiwan.
    const job = normalized(inputOf(fixtureRows()[0]!));
    expect(job.locationCountry).toBe('TW');
    expect(job.locations[0]?.country).toBe('TW');
  });

  it('the id is the page\'s own work_id; without one, the first 16 hex characters of sha1(VIEW_URL); never an invented one', () => {
    expect(twGovVacancyLink('https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=1150900123')).toEqual({ url: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=1150900123', id: '1150900123' });
    expect(twGovVacancyLink('https://web3.dgpa.gov.tw/x.aspx?foo=1&WORK_ID=77')?.id).toBe('77');
    const bare = 'https://web3.dgpa.gov.tw/want03front/ap/some-other-page.aspx?ref=abc';
    const hashed = createHash('sha1').update(bare).digest('hex').slice(0, 16);
    expect(twGovVacancyLink(bare)).toEqual({ url: bare, id: hashed });
    expect(inputOf(rowOf({ VIEW_URL: bare })).externalId).toBe(`dgpa:${hashed}`);
    // An id value that is not an id falls back to the hash of the address.
    expect(twGovVacancyLink('https://web3.dgpa.gov.tw/x.aspx?work_id=has space')?.id).toMatch(/^[0-9a-f]{16}$/);

    // JT-9: a record without VIEW_URL is skipped and counted (no_stable_id).
    expect(twGovRowToInput(rowOf({ VIEW_URL: '' }), NOW)).toEqual({ skip: 'no_stable_id' });
    expect(twGovRowToInput(rowOf({ VIEW_URL: null }), NOW)).toEqual({ skip: 'no_stable_id' });
    // An address that is not a page of dgpa.gov.tw is not a link we show.
    for (const bad of ['https://example.invalid/job?work_id=1', 'https://dgpa.gov.tw.example.invalid/x?work_id=1', 'javascript:alert(1)', 'not a url', 'ftp://web3.dgpa.gov.tw/x']) {
      expect(twGovRowToInput(rowOf({ VIEW_URL: bad }), NOW), bad).toEqual({ skip: 'no_apply_url' });
    }
  });

  it('openings come from NUMBER_OF when it is a positive whole number', () => {
    expect(inputOf(rowOf({ NUMBER_OF: '12' })).headcount).toBe(12);
    for (const none of ['', '0', '-1', '若干', '1.5']) expect(inputOf(rowOf({ NUMBER_OF: none })).headcount, none).toBeNull();
  });

  it('JT-9: the adapter never turns a pay point or an amount in 資格條件 into a figure; the text stays for the pay-text reader', () => {
    const text = 'SYNTHETIC 資格條件：薪點280點，月支報酬新臺幣36,372元。';
    const input = inputOf(rowOf({ WORK_QUALITY: text }));
    for (const field of ['salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'salaryText', 'payFromFieldsOnly'] as const) expect(input[field], field).toBeUndefined();
    expect(input.description).toContain(text);
    // What the normalizer's own reader makes of the sentence is its decision; a figure it stores comes from the posting text, never from this adapter.
    const job = normalized(input);
    expect(job.descriptionPlain).toContain('36,372');
    expect(job.salarySource === null || job.salarySource === 'posting_text').toBe(true);
  });
});

// ── Who may apply ───────────────────────────────────────────────────────────

describe('tw_gov_jobs: PERSON_KIND decides who may apply', () => {
  it('the three public kinds are ingested, untagged', () => {
    expect(TW_GOV_PUBLIC_KINDS).toEqual(['約僱人員', '聘用人員', '其他人員']);
    for (const kind of TW_GOV_PUBLIC_KINDS) {
      const input = inputOf(rowOf({ PERSON_KIND: kind }));
      expect(input.marketTags, kind).toBeUndefined();
      expect(input.description.startsWith(`人員區分：${kind}`), kind).toBe(true);
    }
  });

  it('JT-9: a 一般人員 record (a transfer post for serving civil servants) is skipped and counted by default', async () => {
    expect(twGovRowToInput(fixtureRows()[1]!, NOW)).toEqual({ skip: 'tw_gov_internal_transfer' });
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const result = await harness({ fetch: endpoint.fetch }).step(NOW);
    expect(ids(result)).toEqual(['dgpa:9000000001', 'dgpa:9000000003']);
    expect(result.notes).toMatchObject({ tw_gov_internal_transfer: 1 });
    expect(result.listing).toEqual({ externalIds: ['dgpa:9000000001', 'dgpa:9000000003'], reason: 'source_removed' });
  });

  it('a kind nobody has confirmed as open to the public is not assumed open: skipped and counted apart', async () => {
    for (const kind of ['工友', '教育人員', '駕駛', '主計人員', '人事人員', '技工', '司法人員', '', '未知類別']) {
      expect(twGovRowToInput(rowOf({ PERSON_KIND: kind }), NOW), kind).toEqual({ skip: 'tw_gov_kind_unconfirmed' });
    }
    const endpoint = fakeEndpoint(() => ({ body: documentOf([record(1), record(2, { PERSON_KIND: '工友' }), record(3, { PERSON_KIND: '一般人員' }), record(4, { PERSON_KIND: '教育人員' })]) }));
    const result = await harness({ fetch: endpoint.fetch }).step(NOW);
    expect(ids(result)).toEqual(['dgpa:1']);
    expect(result.notes).toEqual({ tw_gov_kind_unconfirmed: 2, tw_gov_internal_transfer: 1 });
  });

  it('with TW_GOV_JOBS_INCLUDE_TRANSFERS=true they are ingested, each tagged with its PERSON_KIND text as the quote', async () => {
    const transfer = inputOf(fixtureRows()[1]!, { includeTransfers: true });
    expect(transfer.marketTags).toEqual([{ tag: TW_GOV_PERSON_KIND_TAG, evidenceQuote: '一般人員', evidenceUrl: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000002' }]);
    // The same words open the posting text, so the job page says who the post is for.
    expect(normalized(transfer).description.startsWith('人員區分：一般人員')).toBe(true);
    expect(inputOf(rowOf({ PERSON_KIND: '工友' }), { includeTransfers: true }).marketTags).toEqual([{ tag: 'tw_gov_person_kind', evidenceQuote: '工友', evidenceUrl: 'https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=9000000099' }]);
    // A public kind stays untagged with the switch on.
    expect(inputOf(fixtureRows()[0]!, { includeTransfers: true }).marketTags).toBeUndefined();

    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const result = await harness({ fetch: endpoint.fetch, env: { TW_GOV_JOBS_INCLUDE_TRANSFERS: 'true' } }).step(NOW);
    expect(ids(result)).toEqual(['dgpa:9000000001', 'dgpa:9000000002', 'dgpa:9000000003']);
    expect(result.notes?.tw_gov_internal_transfer).toBeUndefined();
  });
});

// ── Privacy ─────────────────────────────────────────────────────────────────

describe('tw_gov_jobs: no e-mail address and no phone number is stored', () => {
  /** What the two contact elements of the fixture hold. */
  const contactValues = [...FIXTURE.matchAll(/<(VITAE_EMAIL|CONTACT_METHOD)>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);
  const contactEmails = contactValues.flatMap((v) => v.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []);
  /** Digit runs of the contact elements, separators removed ("(00)5550-0111" → "0055500111"). */
  const contactDigits = contactValues.flatMap((v) => (v.match(/[\d()\-\s]{7,}/g) ?? []).map((run) => run.replace(/\D/g, '')).filter((run) => run.length >= 7));
  const compact = (v: string) => v.replace(/[\s()\-－—–]/g, '');

  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) strings(v, out);
    else if (value && typeof value === 'object' && !(value instanceof Date)) for (const v of Object.values(value)) strings(v, out);
    return out;
  }

  it('the fixture is SYNTHETIC: every address is on example.invalid and every number is (00)5550-01xx', () => {
    expect(contactValues.length).toBe(5);
    expect(contactEmails.length).toBeGreaterThanOrEqual(3);
    expect(contactDigits.length).toBeGreaterThanOrEqual(4);
    for (const email of FIXTURE.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []) expect(email.endsWith('@example.invalid'), email).toBe(true);
    for (const phone of FIXTURE.match(/\(\d{2,4}\)\s?\d{3,4}-\d{3,4}/g) ?? []) expect(phone, phone).toMatch(/^\(00\)5550-01\d\d$/);
    // No other "@" hides in the file.
    expect((FIXTURE.match(/@/g) ?? []).length).toBe((FIXTURE.match(/@example\.invalid/g) ?? []).length);
  });

  it('JT-9: every produced posting is scanned for "@" and for the digit runs of the contact elements', async () => {
    // Every record, the transfer post included.
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const result = await harness({ fetch: endpoint.fetch, env: { TW_GOV_JOBS_INCLUDE_TRANSFERS: 'true' } }).step(NOW);
    expect(result.jobs.length).toBe(3);
    const produced = strings([result.jobs, result.listing, result.notes, result.cursor]);
    expect(produced.length).toBeGreaterThan(20);
    for (const value of produced) {
      expect(value, value).not.toMatch(/[@＠]/);
      for (const email of contactEmails) expect(value).not.toContain(email);
      for (const digits of contactDigits) expect(compact(value), `${digits} in ${value}`).not.toContain(digits);
      expect(value).not.toContain('假名');
    }
    // The same holds for what the normalizer stores.
    for (const input of result.jobs) {
      const job = normalized(input as TwGovJobsInput);
      for (const value of strings([job.description, job.descriptionPlain, job.location, job.searchText, job.title, job.companyName, job.company])) {
        expect(value).not.toMatch(/[@＠]/);
        for (const digits of contactDigits) expect(compact(value)).not.toContain(digits);
      }
    }
    // The contact details written INSIDE 工作項目 of the first record are taken out with their sentence, and counted.
    expect(FIXTURE).toContain('fake.inline@example.invalid 或電洽 (00)5550-0100');
    expect(result.jobs[0]!.description).toContain('其他臨時交辦事項。');
    expect(result.jobs[0]!.description).not.toContain('履歷');
    expect(result.notes).toMatchObject({ tw_gov_contact_text_removed: 1 });
  });

  it('a sentence that holds an e-mail address or a phone number is left out; the rest of the text stays', () => {
    expect(withoutContactDetails('第一句。請洽王先生 fake@example.invalid。第三句。')).toEqual({ text: '第一句。第三句。', removed: 1 });
    expect(withoutContactDetails('工作內容如下\n聯絡電話：(00)5550-0100 分機 12\n歡迎應徵')).toEqual({ text: '工作內容如下\n歡迎應徵', removed: 1 });
    expect(withoutContactDetails('無聯絡資訊的文字，薪資36,372元，共2名。')).toEqual({ text: '無聯絡資訊的文字，薪資36,372元，共2名。', removed: 0 });
    // Made-up digits in the forms agencies write a number.
    for (const phone of ['02-55500100', '(02)5550-0100', '0900-000-000', '0900000000', '+886-2-55500100', '886-2-5550-0100', '02 5550 0100', '０２－５５５００１００', '049-5550100#123']) {
      expect(withoutContactDetails(`請電洽 ${phone}。其餘保留。`), phone).toEqual({ text: '其餘保留。', removed: 1 });
    }
    // A line id or a full-width at sign is a contact too.
    expect(withoutContactDetails('加入 LINE ＠fakeid 詢問；其餘保留。').text).toBe('其餘保留。');
    // A number announced as one: without its area code, after dotted leaders, as an extension.
    for (const announced of ['聯絡電話：5550-0100', '電話..(00)5550-0100轉123', '傳真 55500100', 'TEL: 5550 0100', '分機 550100']) {
      expect(withoutContactDetails(`${announced}。其餘保留。`), announced).toEqual({ text: '其餘保留。', removed: 1 });
    }
    // A named person to contact goes with the sentence, number or not.
    for (const named of ['意者請洽人事室假名小姐', '聯絡人：假名先生', '承辦人假名女士']) {
      expect(withoutContactDetails(`${named}。其餘保留。`), named).toEqual({ text: '其餘保留。', removed: 1 });
    }
    // A local number without its area code, the usual form inside one city: announced, in brackets, or bare.
    for (const local of [
      '洽詢專線：5550-0100',
      '洽詢專線 55500100',
      '請撥 5550-0100 轉 12',
      '請致電本室(5550-0100)',
      '意者請電 5550-0100 分機 123 洽詢',
      '請洽本室 55500100',
      '報名後撥打 555-0100 確認',
      '本室 5550-0100',
      '本室 555-0100',
      '本室５５５０－０１００',
      '本室 5550-0100-12',
      '本室 5550-0100#12',
    ]) {
      expect(withoutContactDetails(`${local}。其餘保留。`), local).toEqual({ text: '其餘保留。', removed: 1 });
    }
    // A contact label with its colon, and an extension, with a name that carries no honorific.
    for (const labelled of ['聯絡方式：假名 5550-0100', '承辦人：假名，分機1234', '本案聯絡人：人事室假名專員（分機 2105）', '連絡人假名 分機 301', '承辦人: 假名', '如有疑問請洽人事室轉 12']) {
      expect(withoutContactDetails(`${labelled}。其餘保留。`), labelled).toEqual({ text: '其餘保留。', removed: 1 });
    }
    // Dates, amounts, counts, Republic-of-China dates, decimals and document numbers are not contact details.
    for (const safe of [
      '報名期限 115年10月31日',
      '月薪 36,372 元至 41,000 元',
      '有效期間 1151001 至 1151231',
      '2026-10-12 08:30-17:30',
      '共 12 名',
      '0.5 個月獎金',
      '加給 1.0900000000 倍',
      '依 1090036837 號函辦理',
      '須具電話禮儀及櫃檯服務經驗 2 年',
      'Hotel 2025 至 2026 年度專案',
      '服務民眾之先生、小姐及長者',
      // Clock times, date ranges, a pair of years, ranges that a unit follows, and a date after a word of contact.
      '上班時間 0800-1700',
      '早班 0800-1600，晚班 1600-2400',
      '服務期間 115/10/01-115/12/31',
      '計畫期程 2025-2026',
      '交通費 2000-3000 元',
      '薪點 280-3300 點',
      '獎金 5000-8000元',
      '依院授人培字第 2050-1234 號函',
      // A longer hyphenated code is not a local number with an extension.
      '匯款帳號 5550-1100-2123-4567',
      '財產編號 314-5550-1100-22',
      '洽詢期間至 1151031 止',
      '報名期間 1151001-1151031',
      '請洽本室，經費 3000000 元',
      '辦理職務移轉 12 項業務',
      '聯絡方式及報名方式詳見簡章',
    ]) {
      expect(withoutContactDetails(safe), safe).toEqual({ text: safe, removed: 0 });
    }
    expect(withoutContactDetails(null)).toEqual({ text: '', removed: 0 });
    // An address cell that holds a contact detail is not used as an address.
    expect(inputOf(rowOf({ WORK_ADDRESS: '請洽 fake.addr@example.invalid' })).location).toBe('臺北市');
  });
});

// ── One read a day, closure by the listing ──────────────────────────────────

describe('tw_gov_jobs: one read a day, and closure by the complete listing', () => {
  it('makes one request per Taipei day; every later lease of that day answers without a request', async () => {
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const h = harness({ fetch: endpoint.fetch });
    const first = await h.step(NOW);
    expect(first.calls).toBe(1);
    expect(first.exhausted).toBe(true);
    // Three records, two of them listed (the transfer post is not).
    expect(parseTwGovCursor(h.cursor)).toEqual({ v: 1, day: '2026-10-12', rows: 3, listed: 2 });
    // Ingest leases the standing query again every half hour.
    for (const later of ['2026-10-12T04:30:00Z', '2026-10-12T12:00:00Z', '2026-10-12T15:59:59Z']) {
      expect(await h.step(at(later))).toEqual({ jobs: [], calls: 0, exhausted: true });
    }
    expect(endpoint.calls.length).toBe(1);
    // 16:00 UTC is midnight in Taipei: the next day's file is read.
    expect(taipeiDay(at('2026-10-12T15:59:59Z'))).toBe('2026-10-12');
    expect(taipeiDay(at('2026-10-12T16:00:00Z'))).toBe('2026-10-13');
    const next = await h.step(at('2026-10-12T16:00:00Z'));
    expect(next.calls).toBe(1);
    expect(endpoint.calls.length).toBe(2);
    expect(parseTwGovCursor(h.cursor).day).toBe('2026-10-13');
  });

  it('JT-9: a row missing from the next file is closed; a row that comes back is listed again', async () => {
    let file = documentOf([record(1), record(2), record(3)]);
    const endpoint = fakeEndpoint(() => ({ body: file }));
    const h = harness({ fetch: endpoint.fetch });
    const day1 = await h.step(at('2026-10-12T04:00:00Z'));
    expect(day1.listing).toEqual({ externalIds: ['dgpa:1', 'dgpa:2', 'dgpa:3'], reason: 'source_removed' });
    // Ingest wrote the three rows; they are open.
    const stored = openRowsDb(ids(day1));
    expect(await archiveUnlistedJobs(stored.db, 'intl', 'tw_gov_jobs', day1.listing!.externalIds, at('2026-10-12T04:00:10Z'), day1.listing!.reason)).toBe(0);

    // The next day's file no longer lists vacancy 2.
    file = documentOf([record(1), record(3)]);
    const day2 = await h.step(at('2026-10-13T04:00:00Z'));
    expect(day2.listing).toEqual({ externalIds: ['dgpa:1', 'dgpa:3'], reason: 'source_removed' });
    expect(day2.closedExternalIds).toBeUndefined();
    const closedAt = at('2026-10-13T04:00:10Z');
    expect(await archiveUnlistedJobs(stored.db, 'intl', 'tw_gov_jobs', day2.listing!.externalIds, closedAt, day2.listing!.reason)).toBe(1);
    expect(stored.rows.map((r) => [r.externalId, r.archivedAt?.toISOString() ?? null, r.closeReason])).toEqual([
      ['dgpa:1', null, null],
      ['dgpa:2', closedAt.toISOString(), 'source_removed'],
      ['dgpa:3', null, null],
    ]);

    // Listed again a day later: it is a posting of that day's file (the upsert revives a 'source_removed' row).
    file = documentOf([record(1), record(2), record(3)]);
    const day3 = await h.step(at('2026-10-14T04:00:00Z'));
    expect(ids(day3)).toContain('dgpa:2');
    expect(day3.listing!.externalIds).toContain('dgpa:2');
  });

  it('a failed read is an ingest error: no cursor, no listing, nothing closed; the day is read again later', async () => {
    let fail = true;
    const endpoint = fakeEndpoint(() => (fail ? { status: 503 } : { body: FIXTURE }));
    const h = harness({ fetch: endpoint.fetch, cursor: formatTwGovCursor({ v: 1, day: '2026-10-11', rows: 3, listed: 2 }) });
    const failed = await h.step(NOW);
    expect(failed).toEqual({ jobs: [], calls: 1, error: 'tw_gov_jobs:http_503' });
    expect(parseTwGovCursor(h.cursor).day).toBe('2026-10-11');
    // A cut-off file is the same: it never reads as a shorter listing.
    const cut = harness({ fetch: fakeEndpoint(() => ({ body: FIXTURE.slice(0, FIXTURE.length - 40) })).fetch });
    const truncated = await cut.step(NOW);
    expect(truncated).toEqual({ jobs: [], calls: 1, error: 'tw_gov_jobs:truncated' });
    expect(truncated.listing).toBeUndefined();
    // An empty listing is not believed either.
    expect(await harness({ fetch: fakeEndpoint(() => ({ body: documentOf([]) })).fetch }).step(NOW)).toEqual({ jobs: [], calls: 1, error: 'tw_gov_jobs:empty_listing' });
    fail = false;
    const retried = await h.step(at('2026-10-12T05:00:00Z'));
    expect(retried.jobs.length).toBe(2);
    expect(parseTwGovCursor(h.cursor).day).toBe('2026-10-12');
  });

  it('a file that lost more than half of its records closes nothing that day; the next day\'s read decides', async () => {
    const many = Array.from({ length: 10 }, (_, i) => record(i + 1));
    let file = documentOf(many);
    const endpoint = fakeEndpoint(() => ({ body: file }));
    const h = harness({ fetch: endpoint.fetch });
    expect((await h.step(at('2026-10-12T04:00:00Z'))).listing?.externalIds.length).toBe(10);
    file = documentOf(many.slice(0, 4));
    const shrunk = await h.step(at('2026-10-13T04:00:00Z'));
    // Its rows are still read and refreshed; only the closure waits.
    expect(shrunk.jobs.length).toBe(4);
    expect(shrunk.listing).toBeUndefined();
    expect(shrunk.notes).toEqual({ tw_gov_listing_shrank: 1 });
    expect(parseTwGovCursor(h.cursor)).toEqual({ v: 1, day: '2026-10-13', rows: 4, listed: 4 });
    // Still four the day after: the listing is believed and the missing rows close.
    const confirmed = await h.step(at('2026-10-14T04:00:00Z'));
    expect(confirmed.listing?.externalIds.length).toBe(4);
    // Half is not "more than half": five of ten closes as usual.
    const half = harness({ fetch: fakeEndpoint(() => ({ body: documentOf(many.slice(0, 5)) })).fetch, cursor: formatTwGovCursor({ v: 1, day: '2026-10-11', rows: 10, listed: 10 }) });
    expect((await half.step(NOW)).listing?.externalIds.length).toBe(5);
  });

  it('a whole file out of which no vacancy can be listed is an error: no listing, no cursor, nothing closed', async () => {
    const ten = (over: Spec) => documentOf(Array.from({ length: 10 }, (_, i) => record(i + 1, over)));
    const before = formatTwGovCursor({ v: 1, day: '2026-10-11', rows: 10, listed: 10 });
    for (const [why, file, notes] of [
      // Every 人員區分 reworded by the source: no record is one of the public kinds any more.
      ['kinds reworded', ten({ PERSON_KIND: '約僱' }), { tw_gov_kind_unconfirmed: 10 }],
      // Every page address moved to another site.
      ['links off-site', ten({ VIEW_URL: 'https://jobs.example.invalid/want?work_id=1' }), { no_apply_url: 10 }],
      // The page address is no longer in the records at all.
      ['no page address', ten({ VIEW_URL: null }), { no_stable_id: 10 }],
    ] as const) {
      const h = harness({ fetch: fakeEndpoint(() => ({ body: file })).fetch, cursor: before });
      const result = await h.step(NOW);
      expect(result, why).toEqual({ jobs: [], calls: 1, error: 'tw_gov_jobs:nothing_listed', notes });
      expect(result.listing, why).toBeUndefined();
      expect(result.cursor, why).toBeUndefined();
      // Ingest stores no cursor for an error: the day stays unread and is asked again.
      expect(h.cursor, why).toBe(before);
    }
    // The same on a first read, with no earlier count to compare with.
    const first = await harness({ fetch: fakeEndpoint(() => ({ body: ten({ PERSON_KIND: '約僱' }) })).fetch }).step(NOW);
    expect(first.error).toBe('tw_gov_jobs:nothing_listed');
    expect(first.listing).toBeUndefined();
    // Why it must be an error: an empty listing handed to the listing diff closes every open row of the board.
    const stored = openRowsDb(Array.from({ length: 10 }, (_, i) => `dgpa:${i + 1}`));
    expect(await archiveUnlistedJobs(stored.db, 'intl', 'tw_gov_jobs', [], NOW, 'source_removed')).toBe(10);
  });

  it('a file that kept its records but lists fewer than half of the vacancies it listed closes nothing that day', async () => {
    const records = (reworded: number) => Array.from({ length: 10 }, (_, i) => record(i + 1, i < reworded ? { PERSON_KIND: '約僱' } : {}));
    let file = documentOf(records(0));
    const h = harness({ fetch: fakeEndpoint(() => ({ body: file })).fetch });
    expect((await h.step(at('2026-10-12T04:00:00Z'))).listing?.externalIds.length).toBe(10);
    expect(parseTwGovCursor(h.cursor)).toEqual({ v: 1, day: '2026-10-12', rows: 10, listed: 10 });
    // Six of the ten records come back with a 人員區分 this adapter does not know: ten records, four listed.
    file = documentOf(records(6));
    const held = await h.step(at('2026-10-13T04:00:00Z'));
    expect(ids(held)).toEqual(['dgpa:7', 'dgpa:8', 'dgpa:9', 'dgpa:10']);
    expect(held.listing).toBeUndefined();
    expect(held.notes).toEqual({ tw_gov_kind_unconfirmed: 6, tw_gov_listing_shrank: 1 });
    expect(parseTwGovCursor(h.cursor)).toEqual({ v: 1, day: '2026-10-13', rows: 10, listed: 4 });
    // The same the day after: the listing is believed.
    expect((await h.step(at('2026-10-14T04:00:00Z'))).listing?.externalIds).toEqual(['dgpa:7', 'dgpa:8', 'dgpa:9', 'dgpa:10']);
    // Half is not "fewer than half": five of ten listed closes as usual.
    const half = harness({ fetch: fakeEndpoint(() => ({ body: documentOf(records(5)) })).fetch, cursor: formatTwGovCursor({ v: 1, day: '2026-10-11', rows: 10, listed: 10 }) });
    expect((await half.step(NOW)).listing?.externalIds.length).toBe(5);
    // A cursor from before the count existed guards by the records only.
    const old = harness({ fetch: fakeEndpoint(() => ({ body: documentOf(records(6)) })).fetch, cursor: '{"v":1,"day":"2026-10-11","rows":10}' });
    expect((await old.step(NOW)).listing?.externalIds.length).toBe(4);
  });

  it('counts what it skips, by reason, and the listing holds only what it ingests', async () => {
    const file = documentOf([record(1), record(2, { VIEW_URL: '' }), record(3, { VIEW_URL: 'https://example.invalid/x?work_id=3' }), record(4, { PERSON_KIND: '一般人員' }), record(1)]);
    const result = await harness({ fetch: fakeEndpoint(() => ({ body: file })).fetch }).step(NOW);
    expect(ids(result)).toEqual(['dgpa:1', 'dgpa:1']);
    expect(result.notes).toEqual({ no_stable_id: 1, no_apply_url: 1, tw_gov_internal_transfer: 1 });
    // A vacancy listed twice is one entry of the listing.
    expect(result.listing).toEqual({ externalIds: ['dgpa:1'], reason: 'source_removed' });
  });

  it('round-trips its cursor and starts fresh from anything that is not one', () => {
    expect(parseTwGovCursor(formatTwGovCursor({ v: 1, day: '2026-10-12', rows: 2054, listed: 1090 }))).toEqual({ v: 1, day: '2026-10-12', rows: 2054, listed: 1090 });
    for (const junk of [null, undefined, '', 'not json', '[]', '{"v":2,"day":"2026-10-12"}', '2026-10-12T00:00:00.000Z|abc', '{"v":1,"day":"today","rows":-3,"listed":"many"}']) {
      expect(parseTwGovCursor(junk), String(junk)).toEqual({ v: 1, day: null, rows: 0, listed: 0 });
    }
    // A cursor without the count of listed vacancies reads as "not known" (0): only the record count guards that day.
    expect(parseTwGovCursor('{"v":1,"day":"2026-10-11","rows":10}')).toEqual({ v: 1, day: '2026-10-11', rows: 10, listed: 0 });
  });

  it('waits for the next tick when the time left cannot hold the read: not done, nothing asked', async () => {
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const h = harness({ fetch: endpoint.fetch });
    expect(await h.step(NOW, { budgetMs: TW_GOV_JOBS_MIN_BUDGET_MS - 1 })).toEqual({ jobs: [], calls: 0, exhausted: false });
    const aborted = new AbortController();
    aborted.abort();
    expect(await h.step(NOW, { signal: aborted.signal })).toEqual({ jobs: [], calls: 0, exhausted: false });
    expect(endpoint.calls).toEqual([]);
    expect(h.cursor).toBeNull();
    expect((await h.step(NOW, { budgetMs: TW_GOV_JOBS_MIN_BUDGET_MS })).jobs.length).toBe(2);
  });

  it('never fetches for another market, and never throws', async () => {
    const endpoint = fakeEndpoint(() => ({ body: FIXTURE }));
    const adapter = createTwGovJobsAdapter({ env: {}, fetch: endpoint.fetch });
    expect(await adapter.fetch(query(null, 'cn'), { now: NOW })).toEqual({ jobs: [], calls: 0, exhausted: true });
    expect(endpoint.calls).toEqual([]);
    const boom = createTwGovJobsAdapter({
      env: {},
      fetch: () => {
        throw new Error('boom');
      },
    });
    expect(await boom.fetch(query(), { now: NOW })).toEqual({ jobs: [], calls: 1, error: 'tw_gov_jobs:network' });
  });
});

// ── The credit line ─────────────────────────────────────────────────────────

describe('tw_gov_jobs: the OGDL credit line', () => {
  it('JT-9: the card of such a row shows the 人事行政總處 attribution sentence, linked to the licence', async () => {
    const job = normalized(inputOf(fixtureRows()[0]!));
    const ctx = { brand: 'roboapply', market: 'intl', stage: 'ingest' } as const;
    const hooked = await afterNormalize(asMarketHookJob(job), ctx);
    // The dataset is the source: its name, and no separate "original source".
    expect(hooked.sourceName).toBe('事求人');
    expect(hooked.sourceName).toBe(TW_OPEN_DATA_SOURCE_NAMES.tw_gov_jobs);
    expect(hooked.originalSourceName).toBeNull();
    const stored: MarketHookJob = { ...hooked, lastSeenAt: NOW };
    const meta = cardMeta(stored, { ...ctx, stage: 'card' });
    expect(meta.tw_sources).toEqual({
      attribution: { text: '資料來源：行政院人事行政總處 2026「行政院人事行政總處事求人機關徵才資料」，依政府資料開放授權條款第1版公開釋出', url: TW_OGDL_LICENCE_URL },
    });
    // The sentence names the dataset exactly as this adapter does.
    expect(TW_OPEN_DATA_ATTRIBUTIONS.tw_gov_jobs!(2026)).toContain(`${TW_GOV_JOBS_DATASET.provider} 2026「${TW_GOV_JOBS_DATASET.name}」`);
  });

  it('a 事求人 row is held out of every surface that cannot print the line', () => {
    expect(CREDIT_LINE_BOARDS).toContain('tw_gov_jobs');
    expect(Object.keys(TW_OPEN_DATA_ATTRIBUTIONS)).toContain(twGovJobsAdapter.sourceBoards[0]!);
  });

  it('public display stays the owner\'s decision: off by default, on only when PUBLIC_DISPLAY_PROVIDERS names the source', () => {
    expect(normalized(inputOf(fixtureRows()[0]!)).publicDisplay).toBe(false);
    expect(normalized(inputOf(fixtureRows()[0]!), ['tw_gov_jobs']).publicDisplay).toBe(true);
  });
});

// ── Registration ────────────────────────────────────────────────────────────

describe('tw_gov_jobs: registration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is registered once, next to the 台灣就業通 source', () => {
    expect(getSourceAdapter('tw_gov_jobs')).toBe(twGovJobsAdapter);
    expect(getSourceAdapter('tw_open_data')).toBe(twOpenDataAdapter);
    ensureTwGovJobsAdapter();
    ensureTwGovJobsAdapter();
    expect(registeredSourceAdapters().filter((a) => a.provider === 'tw_gov_jobs')).toEqual([twGovJobsAdapter]);
    expect(jobSourceKind('tw_gov_jobs')).toBe('search');
    expect(jobSourceTransport('tw_gov_jobs')).toBe('api');
  });

  it('RoboApply\'s ingest has the adapter, on by default; GoApply\'s never has it', () => {
    // The registered adapter reads the process environment: here, one with no variable of this source.
    for (const name of ['TW_GOV_JOBS_ENABLED', 'TW_GOV_JOBS_URL', 'TW_GOV_JOBS_INCLUDE_TRANSFERS']) vi.stubEnv(name, '');
    const robo = adaptersForBrand(getBrand('roboapply'), {});
    expect(robo.filter((a) => a.provider === 'tw_gov_jobs')).toEqual([twGovJobsAdapter]);
    expect(listEnabledAdaptersFor(getBrand('roboapply'), {}).map((a) => a.provider)).toContain('tw_gov_jobs');
    const described = sourcesForBrand(getBrand('roboapply'), {}).find((s) => s.provider === 'tw_gov_jobs')!;
    expect(described.status()).toEqual({ enabled: true, transport: 'api', reason: null });
    expect(described.costModel).toBe('free');
    expect(described.sourceBoards).toEqual(['tw_gov_jobs']);
    // The switch turns the registered adapter off, with its reason.
    vi.stubEnv('TW_GOV_JOBS_ENABLED', 'false');
    expect(described.status()).toEqual({ enabled: false, transport: 'api', reason: 'kill_switch' });
    expect(listEnabledAdaptersFor(getBrand('roboapply'), {}).map((a) => a.provider)).not.toContain('tw_gov_jobs');
    vi.stubEnv('TW_GOV_JOBS_ENABLED', '');
    const go = adaptersForBrand(getBrand('goapply'), {});
    expect(go.map((a) => a.provider)).not.toContain('tw_gov_jobs');
    expect(adaptersForBrand(getBrand('goapply'), { JOB_PROVIDERS_GOAPPLY: 'tw_gov_jobs,bank_gohire' }).map((a) => a.provider)).not.toContain('tw_gov_jobs');
    // RoboApply can narrow it away like any other source.
    expect(adaptersForBrand(getBrand('roboapply'), { JOB_PROVIDERS_ROBOAPPLY: 'bank_robohire' }).map((a) => a.provider)).not.toContain('tw_gov_jobs');
  });
});
