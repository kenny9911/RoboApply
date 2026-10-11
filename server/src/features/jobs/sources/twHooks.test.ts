// @vitest-environment node
//
// Taiwan open-data rows: the OGDL attribution (MKT-3E; JT-2, MARKET_STRATEGY
// §1.3). The licence voids itself without it, so the sentence is pinned word
// for word. Pure: no network, no database.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MARKET_HOOK_SETS, afterNormalize, cardMeta, type MarketHookContext, type MarketHookJob } from '../marketHooks.js';
import { normalizeProviderJob, asMarketHookJob } from '../normalize/index.js';
import { parseTwOpenDataCsv, twOpenDataRowToInput, TW_OPEN_DATA_DATASET } from './twOpenData.js';
import { TW_OGDL_LICENCE_URL, TW_OPEN_DATA_ATTRIBUTIONS, TW_OPEN_DATA_SOURCE_NAMES, createTwSourcesHooks, taipeiYear, twAttribution, twSourcesHooks, withOpenDataSourceName } from './twHooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CARD: MarketHookContext = { brand: 'roboapply', market: 'intl', stage: 'card' };
const INGEST: MarketHookContext = { brand: 'roboapply', market: 'intl', stage: 'ingest' };

const SENTENCE_2026 = '資料來源：勞動部勞動力發展署 2026「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出';
const GOV_SENTENCE_2026 = '資料來源：行政院人事行政總處 2026「行政院人事行政總處事求人機關徵才資料」，依政府資料開放授權條款第1版公開釋出';

const row = (over: Partial<MarketHookJob> = {}): MarketHookJob => ({
  id: 'job-1',
  market: 'intl',
  provider: 'tw_open_data',
  sourceBoard: 'tw_open_data',
  locationCountry: 'TW',
  lastSeenAt: new Date('2026-10-11T04:00:00.000Z'),
  sourceName: '台灣就業通',
  ...over,
});

describe('tw_sources: the attribution sentence', () => {
  it('JT-2: a tw_open_data row last seen in 2026 carries exactly the sentence with 2026 and the licence link', () => {
    expect(cardMeta(row(), CARD).tw_sources).toEqual({ attribution: { text: SENTENCE_2026, url: 'https://data.gov.tw/license' } });
    expect(TW_OGDL_LICENCE_URL).toBe('https://data.gov.tw/license');
    expect(TW_OPEN_DATA_ATTRIBUTIONS.tw_open_data!(2026)).toBe(SENTENCE_2026);
  });

  it('names what the licence\'s Exhibit asks for: the provider, the year, the dataset\'s full name and the licence statement', () => {
    const text = TW_OPEN_DATA_ATTRIBUTIONS.tw_open_data!(2027);
    expect(text).toContain(TW_OPEN_DATA_DATASET.provider);
    expect(text).toContain('2027');
    expect(text).toContain(`「${TW_OPEN_DATA_DATASET.name}」`);
    expect(text).toContain(TW_OPEN_DATA_DATASET.licence);
    expect(TW_OPEN_DATA_DATASET.licenceUrl).toBe(TW_OGDL_LICENCE_URL);
    // Traditional Chinese, whatever the reader's locale: the sentence is the licence's wording, not UI copy.
    expect(text).not.toMatch(/[数据来劳动发开条权释资]/);
  });

  it('the second dataset (事求人, 7229) has its own sentence, ready for its adapter', () => {
    expect(TW_OPEN_DATA_ATTRIBUTIONS.tw_gov_jobs!(2026)).toBe(GOV_SENTENCE_2026);
    expect(cardMeta(row({ provider: 'tw_gov_jobs', sourceBoard: 'tw_gov_jobs' }), CARD).tw_sources).toEqual({ attribution: { text: GOV_SENTENCE_2026, url: 'https://data.gov.tw/license' } });
    expect(Object.keys(TW_OPEN_DATA_ATTRIBUTIONS).sort()).toEqual(['tw_gov_jobs', 'tw_open_data']);
    expect(Object.keys(TW_OPEN_DATA_SOURCE_NAMES).sort()).toEqual(['tw_gov_jobs', 'tw_open_data']);
  });

  it('the year is the Taipei-time year the row was last seen, or of now when the row has none', () => {
    // 2026-12-31T16:30Z is already 2027 in Taipei (UTC+8).
    expect(taipeiYear(new Date('2026-12-31T15:59:59.000Z'))).toBe(2026);
    expect(taipeiYear(new Date('2026-12-31T16:00:00.000Z'))).toBe(2027);
    expect(twAttribution(row({ lastSeenAt: new Date('2026-12-31T16:30:00.000Z') }))!.text).toContain(' 2027「');
    expect(twAttribution(row({ lastSeenAt: '2025-06-01T00:00:00.000Z' }))!.text).toContain(' 2025「');
    const now = new Date('2028-03-01T00:00:00.000Z');
    for (const missing of [undefined, null, '', 'not a date', new Date(Number.NaN), 42]) {
      expect(twAttribution(row({ lastSeenAt: missing }), now)!.text, String(missing)).toContain(' 2028「');
    }
    const fixedNow = createTwSourcesHooks({ now: () => now });
    expect(fixedNow.cardMeta!(row({ lastSeenAt: null }), CARD)).toEqual({ attribution: { text: SENTENCE_2026.replace('2026', '2028'), url: 'https://data.gov.tw/license' } });
  });

  it('is the same sentence in every locale and for every stage: nothing about the reader changes it', () => {
    for (const stage of ['card', 'ingest', 'enrich', 'import'] as const) {
      expect(cardMeta(row(), { brand: 'roboapply', market: 'intl', stage }).tw_sources).toEqual({ attribution: { text: SENTENCE_2026, url: 'https://data.gov.tw/license' } });
    }
  });

  it('JT-2: a Greenhouse row in Taiwan carries none, and neither does any other source', () => {
    const greenhouse = row({ provider: 'ats_public', sourceBoard: 'greenhouse', atsType: 'greenhouse', sourceName: 'Appier · Greenhouse' });
    const meta = cardMeta(greenhouse, CARD);
    expect(meta.tw_sources).toBeUndefined();
    // The Taiwan pay / permit block of the employer boards is still there for it.
    expect(meta.ats_public).toMatchObject({ country: 'TW' });
    for (const other of ['jsearch', 'activejobs', 'bank_robohire', 'user_import', 'linkedin', '', 'tw_open_data_copy']) {
      expect(cardMeta(row({ provider: other, sourceBoard: other }), CARD).tw_sources, other).toBeUndefined();
    }
    expect(cardMeta(row({ sourceBoard: undefined }), CARD).tw_sources).toBeUndefined();
    expect(twAttribution(row({ sourceBoard: 42 }))).toBeNull();
  });

  it('GoApply never shows it: the dataset belongs to the international market', () => {
    expect(cardMeta(row({ market: 'cn' }), { brand: 'goapply', market: 'cn', stage: 'card' }).tw_sources).toBeUndefined();
    expect(twAttribution(row({ market: 'cn' }))).toBeNull();
  });

  it('an open-data row keeps its Taiwan pay block next to the attribution', () => {
    const meta = cardMeta(row({ salaryText: '依學經歷、證照核薪(每月經常性薪資達4萬元以上)', salaryDisclosed: false }), CARD);
    expect(Object.keys(meta).sort()).toEqual(['ats_public', 'tw_sources']);
    expect(meta.ats_public).toMatchObject({ pay: { negotiable: true, disclosed: false, text: '依學經歷、證照核薪' } });
    expect(JSON.stringify(meta.tw_sources)).not.toMatch(/4萬|40,?000/);
  });

  it('matches the board whatever its letter case', () => {
    expect(twAttribution(row({ sourceBoard: ' TW_Open_Data ' }))!.text).toBe(SENTENCE_2026);
  });
});

describe('tw_sources: the source name', () => {
  it('afterNormalize names the dataset\'s publisher and leaves no separate original source', async () => {
    const page = parseTwOpenDataCsv(readFileSync(join(HERE, '__fixtures__', 'tw', 'joblist.synthetic.csv'), 'utf8'));
    if (!page.ok) throw new Error(page.error);
    const mapped = twOpenDataRowToInput(page.rows[0]!, new Date('2026-10-11T04:00:00.000Z'));
    if (!('input' in mapped)) throw new Error('skipped');
    const job = normalizeProviderJob(mapped.input, 'tw_open_data', { market: 'intl', now: new Date('2026-10-11T04:00:00.000Z') });
    const hooked = await afterNormalize(asMarketHookJob(job), INGEST);
    expect(hooked).toMatchObject({ sourceName: '台灣就業通', originalSourceName: null, sourceBoard: 'tw_open_data', provider: 'tw_open_data' });
    // A row that arrives with another name or an "original source" is put right.
    expect(withOpenDataSourceName(row({ sourceName: 'Somebody', originalSourceName: 'Someone else' }))).toMatchObject({ sourceName: '台灣就業通', originalSourceName: null });
    expect(withOpenDataSourceName(row({ sourceBoard: 'tw_gov_jobs', sourceName: null }))).toMatchObject({ sourceName: '事求人', originalSourceName: null });
  });

  it('leaves every other row exactly as it was', async () => {
    const greenhouse = row({ provider: 'jsearch', sourceBoard: 'jsearch', sourceName: 'Google for Jobs', originalSourceName: '104人力銀行' });
    expect(withOpenDataSourceName(greenhouse)).toBe(greenhouse);
    expect(twSourcesHooks.appliesTo(greenhouse, INGEST)).toBe(false);
    expect(await afterNormalize(greenhouse, INGEST)).toMatchObject({ sourceName: 'Google for Jobs', originalSourceName: '104人力銀行' });
  });
});

describe('tw_sources: the hook set', () => {
  it('is registered once, after the employer-board set', () => {
    expect(MARKET_HOOK_SETS.map((s) => s.id)).toEqual(['cn', 'ats_public', 'tw_sources']);
    expect(MARKET_HOOK_SETS.filter((s) => s === twSourcesHooks)).toHaveLength(1);
    expect(twSourcesHooks.afterEnrich).toBeUndefined();
  });

  it('JT-2: no 台灣就業通 logo asset is referenced anywhere in the source or the web bundle (trademarks are outside the licence)', () => {
    const root = join(HERE, '..', '..', '..', '..', '..');
    const logo = /taiwanjobs[^'"\s]*\.(png|svg|jpe?g|gif|webp|ico)|台灣就業通[^'"\n]*\.(png|svg|jpe?g|gif|webp)|taiwanjobs[-_]?logo|logo[-_]?taiwanjobs/i;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'generated' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|css|json|mjs)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx') && logo.test(readFileSync(full, 'utf8'))) offenders.push(full);
        else if (/taiwanjobs|就業通/i.test(name) && /\.(png|svg|jpe?g|gif|webp|ico)$/i.test(name)) offenders.push(full);
      }
    };
    for (const dir of ['server/src/features/jobs/sources', 'components/features/market', 'public']) walk(join(root, dir));
    expect(offenders).toEqual([]);
  });
});
