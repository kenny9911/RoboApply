// @vitest-environment node
//
// The Taiwan district table (MKT-3E, JT-2): 22 counties with the open-data
// API's `CITY` codes and the districts by 3-digit postal code. Pure: the
// table is a committed file built from two published lists; no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TW_COUNTIES,
  TW_DISTRICTS,
  TW_DISTRICTS_SOURCE,
  districtByZip,
  districtsOfCounty,
  findTwDistrict,
  twCounty,
  validateTwDistricts,
  type TwDistrictData,
} from './twDistricts.js';
import * as geo from './index.js';

/** The 22 codes of the interface document as JOB_SOURCES_TW.md 3.1 lists them, in its order. */
const DOCUMENTED: ReadonlyArray<[string, string]> = [
  ['01', '台北市'], ['31', '新北市'], ['11', '基隆市'], ['33', '桃園市'], ['12', '新竹市'], ['34', '新竹縣'], ['35', '苗栗縣'], ['13', '台中市'],
  ['38', '南投縣'], ['37', '彰化縣'], ['39', '雲林縣'], ['14', '嘉義市'], ['40', '嘉義縣'], ['15', '台南市'], ['02', '高雄市'], ['43', '屏東縣'],
  ['32', '宜蘭縣'], ['45', '花蓮縣'], ['46', '台東縣'], ['44', '澎湖縣'], ['23', '金門縣'], ['24', '連江縣'],
];

const table = (over: Partial<TwDistrictData> = {}): TwDistrictData => ({
  version: 1,
  asOf: '2026-10-11',
  source: { ...TW_DISTRICTS_SOURCE },
  counties: TW_COUNTIES.map((c) => ({ ...c })),
  districts: TW_DISTRICTS.map((d) => ({ ...d })),
  ...over,
});

describe('twDistricts: the shipped table', () => {
  it('is valid: 22 counties with unique two-digit codes, unique three-digit district codes, every district in a listed county, the source block filled', () => {
    expect(validateTwDistricts()).toEqual([]);
    expect(TW_DISTRICTS_SOURCE.url).toMatch(/^https:\/\//);
    expect(TW_DISTRICTS_SOURCE.license).toBe('政府資料開放授權條款-第1版');
    expect(TW_DISTRICTS_SOURCE.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('pins the 22 county codes to the interface document, in its order', () => {
    expect(TW_COUNTIES.map((c) => [c.code, c.name])).toEqual(DOCUMENTED);
    // The 臺 spelling exists exactly for the four names written with 台.
    expect(TW_COUNTIES.filter((c) => c.nameAlt).map((c) => c.nameAlt)).toEqual(['臺北市', '臺中市', '臺南市', '臺東縣']);
  });

  it('every county has districts, in postal-code order, and each code leads back to its row', () => {
    for (const c of TW_COUNTIES) {
      const rows = districtsOfCounty(c.code);
      expect(rows.length, c.name).toBeGreaterThan(0);
      expect(rows.map((r) => r.zip3)).toEqual([...rows.map((r) => r.zip3)].sort());
      for (const r of rows) {
        expect(r.county).toBe(c.name);
        expect(districtByZip(r.zip3)).toEqual(r);
      }
    }
    expect(TW_COUNTIES.reduce((n, c) => n + districtsOfCounty(c.code).length, 0)).toBe(TW_DISTRICTS.length);
    expect(twCounty('34')?.name).toBe('新竹縣');
    expect(twCounty('99')).toBeNull();
    expect(districtsOfCounty('99')).toEqual([]);
    expect(districtByZip('000')).toBeNull();
  });

  it('a code shared by a whole city is one row with every name', () => {
    expect(districtByZip('300')).toMatchObject({ countyCode: '12', county: '新竹市', districts: ['東區', '北區', '香山區'] });
    expect(districtByZip('600')).toMatchObject({ countyCode: '14', county: '嘉義市', districts: ['東區', '西區'] });
    expect(new Set(TW_DISTRICTS.map((d) => d.zip3)).size).toBe(TW_DISTRICTS.length);
  });

  it('files a row under the county its published Chinese name starts with, also 817 and 819', () => {
    // The postal list writes these two rows 高雄市東沙群島 and 高雄市南沙群島 (checked against the resource on
    // 2026-10-11); only their English names say "Nanhai Islands". The county is the list's, not ours.
    expect(districtByZip('817')).toMatchObject({ countyCode: '02', county: '高雄市', district: '東沙群島' });
    expect(districtByZip('819')).toMatchObject({ countyCode: '02', county: '高雄市', district: '南沙群島' });
    expect(TW_DISTRICTS).toHaveLength(367);
    expect(districtsOfCounty('02')).toHaveLength(40);
    // The one row of the list that names none of the 22 counties is not a district.
    expect(districtByZip('290')).toBeNull();
  });

  it('is part of the public surface of the geo area', () => {
    expect(geo.findTwDistrict).toBe(findTwDistrict);
    expect(geo.TW_COUNTIES).toBe(TW_COUNTIES);
    expect(geo.districtsOfCounty).toBe(districtsOfCounty);
    expect(geo.validateTwDistricts).toBe(validateTwDistricts);
  });
});

describe('findTwDistrict', () => {
  it.each([
    ['新竹縣竹北市', '新竹縣', '34', '竹北市', '302'],
    ['臺北市士林區', '台北市', '01', '士林區', '111'],
    ['台北市士林區', '台北市', '01', '士林區', '111'],
    ['台北市中山區', '台北市', '01', '中山區', '104'],
    ['基隆市中山區', '基隆市', '11', '中山區', '203'],
    ['臺南市善化區', '台南市', '15', '善化區', '741'],
    ['新竹市北區', '新竹市', '12', '北區', '300'],
    ['嘉義市西區', '嘉義市', '14', '西區', '600'],
    ['連江縣南竿鄉', '連江縣', '24', '南竿鄉', '209'],
    [' 台中市 西屯區 ', '台中市', '13', '西屯區', '407'],
  ])('%s → %s (%s) + %s (%s)', (text, county, countyCode, district, zip3) => {
    expect(findTwDistrict(text)).toEqual({ county, countyCode, district, zip3 });
  });

  it('keeps the district names and codes of the postal list for these cases', () => {
    // The expectations above read their codes from the committed table, not from memory.
    for (const [zip3, county, district] of [['302', '新竹縣', '竹北市'], ['111', '台北市', '士林區'], ['104', '台北市', '中山區'], ['203', '基隆市', '中山區'], ['741', '台南市', '善化區'], ['209', '連江縣', '南竿鄉'], ['407', '台中市', '西屯區']] as const) {
      expect(districtByZip(zip3)).toMatchObject({ county, district });
    }
  });

  it('a county with no district: 不限, the county alone, or a district the table does not have', () => {
    expect(findTwDistrict('台中市不限')).toEqual({ county: '台中市', countyCode: '13', district: null, zip3: null });
    expect(findTwDistrict('桃園市')).toEqual({ county: '桃園市', countyCode: '33', district: null, zip3: null });
    expect(findTwDistrict('臺東縣某某鄉')).toEqual({ county: '台東縣', countyCode: '46', district: null, zip3: null });
  });

  it('is null without a county name at the start, and never throws', () => {
    for (const text of ['', '   ', '竹北市', '中山區', 'Taipei', '上海市浦東新區', null, undefined]) expect(findTwDistrict(text as string), String(text)).toBeNull();
  });

  it('reads 台 and 臺 as one character in district names too', () => {
    const withTai = TW_DISTRICTS.find((d) => /[台臺]/.test(d.district));
    expect(withTai).toBeDefined();
    const other = withTai!.district.includes('臺') ? withTai!.district.replace(/臺/g, '台') : withTai!.district.replace(/台/g, '臺');
    expect(findTwDistrict(`${withTai!.county}${other}`)).toMatchObject({ district: withTai!.district, zip3: withTai!.zip3 });
  });
});

describe('validateTwDistricts', () => {
  it('accepts a table with the 22 counties and no districts (the sweep then uses its fallback split)', () => {
    expect(validateTwDistricts(table({ districts: [] }))).toEqual([]);
  });

  it('names each structural problem', () => {
    const counties = TW_COUNTIES.map((c) => ({ ...c }));
    expect(validateTwDistricts(table({ counties: counties.slice(1) }))).toContain('expected 22 counties, found 21');
    expect(validateTwDistricts(table({ counties: counties.map((c, i) => (i === 1 ? { ...c, code: '01' } : c)) }))).toContain('duplicate county code 01');
    expect(validateTwDistricts(table({ counties: counties.map((c, i) => (i === 0 ? { ...c, code: '1' } : c)) }))).toContain('county code 1 is not two digits');
    const d = TW_DISTRICTS.map((x) => ({ ...x }));
    expect(validateTwDistricts(table({ districts: [{ ...d[0]!, zip3: '10' }] }))).toContain('district zip3 10 is not three digits');
    expect(validateTwDistricts(table({ districts: [d[0]!, { ...d[1]!, zip3: d[0]!.zip3 }] }))).toContain(`duplicate district zip3 ${d[0]!.zip3}`);
    expect(validateTwDistricts(table({ districts: [{ ...d[0]!, countyCode: '99' }] }))).toContain(`district ${d[0]!.zip3}: county code 99 is not listed`);
    expect(validateTwDistricts(table({ source: { ...TW_DISTRICTS_SOURCE, license: ' ' } }))).toContain('source.license is empty');
    expect(validateTwDistricts(table({ source: { ...TW_DISTRICTS_SOURCE, url: 'http://example.test/list' } }))).toContain('source.url is not an https URL');
  });
});

describe('twDistricts with an empty district list (no official list could be bundled)', () => {
  afterEach(() => {
    vi.doUnmock('./twDistricts.json');
    vi.resetModules();
  });

  it('every accessor answers with an empty list or null, the counties still resolve, and nothing throws', async () => {
    vi.resetModules();
    vi.doMock('./twDistricts.json', () => ({
      default: { version: 1, asOf: '2026-10-11', source: { ...TW_DISTRICTS_SOURCE }, counties: TW_COUNTIES.map((c) => ({ ...c })), districts: [] },
    }));
    const empty = await import('./twDistricts.js');
    expect(empty.TW_DISTRICTS).toEqual([]);
    expect(empty.TW_COUNTIES).toHaveLength(22);
    expect(empty.validateTwDistricts()).toEqual([]);
    for (const c of empty.TW_COUNTIES) expect(empty.districtsOfCounty(c.code), c.name).toEqual([]);
    expect(empty.districtByZip('100')).toBeNull();
    expect(empty.twCounty('01')?.name).toBe('台北市');
    // The county is still read; the district is not known.
    expect(empty.findTwDistrict('新竹縣竹北市')).toEqual({ county: '新竹縣', countyCode: '34', district: null, zip3: null });
    expect(empty.findTwDistrict('台中市不限')).toEqual({ county: '台中市', countyCode: '13', district: null, zip3: null });
    expect(empty.findTwDistrict('Taipei')).toBeNull();
  });
});
