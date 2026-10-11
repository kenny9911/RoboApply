// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CITIES,
  CITY_TABLE_SOURCE,
  COUNTRIES,
  SUBDIVISIONS,
  citiesNamed,
  cityById,
  cityKey,
  cityLabel,
  countryByCode,
  countryByName,
  distanceKm,
  findCity,
  parseLocation,
  parseLocations,
  resolveCountry,
  twDistrictOfText,
  scanCjkCities,
  statedWorkModel,
  subdivision,
  subdivisionCountries,
  TW_COUNTIES,
  TW_DISTRICTS,
  validateCityTable,
} from './index.js';
import { buildCityTableFromGeoNames, GEONAMES_SOURCE } from './buildCities.js';
import type { CityTable } from './cities.js';

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));

describe('city table', () => {
  it('is valid: unique ids with a country prefix, known countries, coordinates in range, a source with a licence', () => {
    expect(validateCityTable({ version: 1, asOf: '', source: CITY_TABLE_SOURCE, cities: [...CITIES] }, COUNTRY_CODES)).toEqual([]);
    expect(CITIES.length).toBeGreaterThan(200);
  });

  it('says honestly where its data comes from', () => {
    expect(CITY_TABLE_SOURCE.id).toBe('roboapply_seed');
    expect(CITY_TABLE_SOURCE.notes).toMatch(/GeoNames/);
  });

  it('covers every Taiwan special municipality and the main mainland hubs with both Chinese scripts', () => {
    for (const id of ['tw-taipei', 'tw-new-taipei', 'tw-taoyuan', 'tw-taichung', 'tw-tainan', 'tw-kaohsiung', 'tw-hsinchu']) {
      const c = cityById(id)!;
      expect(c.zh && c.zhHant, id).toBeTruthy();
    }
    for (const id of ['cn-beijing', 'cn-shanghai', 'cn-shenzhen', 'cn-guangzhou', 'cn-hangzhou', 'cn-chengdu']) expect(cityById(id)?.zh).toBeTruthy();
  });

  it('flags structural problems', () => {
    const bad: CityTable = {
      version: 1,
      asOf: '',
      source: { id: '', name: '', publisher: '', url: null, license: '' },
      cities: [
        { id: 'us-a', name: 'A', country: 'US', lat: 1, lng: 1 },
        { id: 'us-a', name: '', country: 'XX', lat: 91, lng: 0 },
        { id: 'Bad Id', name: 'B', country: 'US', lat: 0, lng: 0 },
        { id: 'gb-c', name: 'C', country: 'US', lat: 0, lng: 0 },
      ],
    };
    const errors = validateCityTable(bad, COUNTRY_CODES);
    expect(errors).toEqual(
      expect.arrayContaining([
        'duplicate id us-a',
        'us-a: unknown country XX',
        'us-a: no name',
        'us-a: coordinates out of range',
        'bad id Bad Id',
        'gb-c: id prefix does not match country US',
        'source and license are required',
      ]),
    );
  });
});

describe('country and subdivision lookups', () => {
  it('resolves codes, names, aliases and CJK names', () => {
    expect(countryByCode('us')?.code).toBe('US');
    expect(countryByCode(null)).toBeNull();
    expect(countryByName('United States of America')?.code).toBe('US');
    expect(countryByName('臺灣')?.code).toBe('TW');
    expect(countryByName('中国大陆')?.code).toBe('CN');
    expect(countryByName('Atlantis')).toBeNull();
    expect(countryByName(undefined)).toBeNull();
    expect(resolveCountry('UK')?.code).toBe('GB');
    expect(resolveCountry('tw')?.code).toBe('TW');
    expect(resolveCountry('Taiwan')?.code).toBe('TW');
    expect(resolveCountry('ZZ')).toBeNull();
    expect(resolveCountry(null)).toBeNull();
  });

  it('knows which countries use a region code', () => {
    expect(subdivision('US', 'tx')?.name).toBe('Texas');
    expect(subdivision('US', 'Texas')?.code).toBe('TX');
    expect(subdivision('CN', '广东省')?.code).toBe('Guangdong');
    expect(subdivision('US', null)).toBeNull();
    expect(subdivisionCountries('WA').sort()).toEqual(['AU', 'US']);
    expect(subdivisionCountries('ZZ')).toEqual([]);
    expect(SUBDIVISIONS.filter((s) => s.country === 'US')).toHaveLength(52);
  });
});

describe('city lookups', () => {
  it('matches names in any script and spelling', () => {
    expect(findCity('Taipei City')?.id).toBe('tw-taipei');
    expect(findCity('臺北市')?.id).toBe('tw-taipei');
    expect(findCity('台北')?.id).toBe('tw-taipei');
    expect(findCity('München')?.id).toBe('de-munich');
    expect(findCity('Bangalore')?.id).toBe('in-bengaluru');
    expect(findCity("Xi'an")?.id).toBe('cn-xian');
    expect(findCity('Atlantis')).toBeNull();
    expect(findCity(null)).toBeNull();
  });

  it('resolves ambiguous names with the stated country and region', () => {
    expect(citiesNamed('Cambridge').map((c) => c.id)).toEqual(['us-cambridge', 'gb-cambridge']);
    expect(findCity('Cambridge', { country: 'GB' })?.id).toBe('gb-cambridge');
    expect(findCity('Birmingham', { country: 'US', region: 'AL' })?.id).toBe('us-birmingham');
    expect(findCity('Birmingham', { country: 'US', region: 'ZZ' })?.id).toBe('us-birmingham');
    expect(findCity('Cambridge', { country: 'FR' })).toBeNull();
  });

  it('scans unseparated CJK text: the longest name wins', () => {
    expect(scanCjkCities('新竹縣竹北市光明六路')?.id).toBe('tw-zhubei');
    expect(scanCjkCities('上海市静安区南京西路')?.id).toBe('cn-shanghai');
    expect(scanCjkCities('上海市', 'TW')).toBeNull();
    expect(scanCjkCities('Austin')).toBeNull();
  });

  it('labels cities per locale and measures distance', () => {
    const taipei = cityById('tw-taipei')!;
    expect(cityLabel(taipei, 'zh')).toBe('台北');
    expect(cityLabel(taipei, 'zh-TW')).toBe('臺北');
    expect(cityLabel(taipei, 'en')).toBe('Taipei');
    expect(cityLabel(cityById('us-plano')!, 'zh')).toBe('Plano');
    expect(cityLabel(cityById('us-plano')!, 'zh-TW')).toBe('Plano');
    const d = distanceKm(cityById('tw-taipei')!, cityById('tw-hsinchu')!);
    expect(d).toBeGreaterThan(55);
    expect(d).toBeLessThan(75);
    expect(cityKey(' Taipei  City ')).toBe('taipei');
    expect(cityById(null)).toBeNull();
  });
});

describe('statedWorkModel', () => {
  it.each([
    ['Remote', 'remote'],
    ['Remote - US', 'remote'],
    ['Hybrid (Taipei)', 'hybrid'],
    ['On-site', 'onsite'],
    ['远程办公', 'remote'],
    ['遠端', 'remote'],
    ['混合办公', 'hybrid'],
    ['Remote or Hybrid', null],
    ['Not remote', null],
    ['Austin, TX', null],
    ['', null],
    [null, null],
  ])('%s → %s', (text, expected) => {
    expect(statedWorkModel(text as string | null)).toBe(expected);
  });
});

describe('parseLocation', () => {
  const cases: [string, Partial<{ city: string | null; cityName: string | null; region: string | null; country: string | null; countrySource: string | null; workModel: string | null; remoteScope: string | null }>][] = [
    ['Austin, TX', { city: 'us-austin', region: 'TX', country: 'US', countrySource: 'city_table' }],
    ['Austin, TX, US', { city: 'us-austin', region: 'TX', country: 'US', countrySource: 'text' }],
    ['Toronto, ON, CA', { city: 'ca-toronto', region: 'ON', country: 'CA' }],
    ['Toronto, ON, Canada', { city: 'ca-toronto', region: 'ON', country: 'CA', countrySource: 'text' }],
    ['London, England, United Kingdom', { city: 'gb-london', region: 'England', country: 'GB' }],
    ['Cambridge, UK', { city: 'gb-cambridge', country: 'GB' }],
    ['Cambridge, MA', { city: 'us-cambridge', region: 'MA', country: 'US' }],
    ['Perth, WA', { city: 'au-perth', region: 'WA', country: 'AU' }],
    ['Portland, ME', { city: null, cityName: 'Portland', region: 'ME', country: 'US' }],
    ['Springfield, IL', { city: null, cityName: 'Springfield', region: 'IL', country: 'US' }],
    ['New York, NY 10001', { city: 'us-new-york', region: 'NY' }],
    ['NYC', { city: 'us-new-york', country: 'US' }],
    ['Greater Boston Area', { city: 'us-boston' }],
    ['Seattle, Washington', { city: 'us-seattle', region: 'WA' }],
    ['Bengaluru, Karnataka, India', { city: 'in-bengaluru', region: 'KA', country: 'IN' }],
    ['Singapore', { city: 'sg-singapore', country: 'SG' }],
    ['Hong Kong', { city: 'hk-hong-kong', country: 'HK' }],
    ['US', { city: null, cityName: null, country: 'US' }],
    ['CA', { city: null, region: 'CA', country: 'US' }],
    ['Remote - US', { city: null, country: 'US', workModel: 'remote', remoteScope: 'US' }],
    ['Remote', { country: null, workModel: 'remote', remoteScope: null }],
    ['Remote, Worldwide', { workModel: 'remote', remoteScope: 'global' }],
    ['Hybrid (Taipei City, Taiwan)', { city: 'tw-taipei', country: 'TW', workModel: 'hybrid', remoteScope: null }],
    ['Taiwan, Taipei City', { city: 'tw-taipei', country: 'TW' }],
    ['臺北市信義區', { city: 'tw-taipei', country: 'TW' }],
    ['台灣台北市內湖區', { city: 'tw-taipei', country: 'TW', countrySource: 'text' }],
    ['新北市, 台灣', { city: 'tw-new-taipei', country: 'TW' }],
    ['新竹縣竹北市', { city: 'tw-zhubei', region: 'Hsinchu County', country: 'TW' }],
    ['上海市静安区', { city: 'cn-shanghai', region: 'Shanghai', country: 'CN' }],
    ['中国 北京市朝阳区', { city: 'cn-beijing', country: 'CN', countrySource: 'text' }],
    ['广东省深圳市', { city: 'cn-shenzhen', region: 'Guangdong', country: 'CN' }],
    ['München, Germany', { city: 'de-munich', country: 'DE' }],
    ['Multiple Locations', { city: null, cityName: null, country: null }],
    ['Smallville, Atlantis', { city: null, cityName: 'Smallville', country: null }],
    ['', { city: null, cityName: null, country: null, workModel: null }],
  ];

  it.each(cases)('%s', (text, expected) => {
    const p = parseLocation(text);
    const actual = {
      city: p.city?.id ?? null,
      cityName: p.cityName,
      region: p.region,
      country: p.country,
      countrySource: p.countrySource,
      workModel: p.workModel,
      remoteScope: p.remoteScope,
    };
    expect(actual).toMatchObject(expected);
  });

  it('takes coordinates only from the table', () => {
    expect(parseLocation('Austin, TX')).toMatchObject({ lat: 30.27, lng: -97.74 });
    expect(parseLocation('Springfield, IL')).toMatchObject({ lat: null, lng: null });
  });

  it('uses separate provider fields as hints', () => {
    expect(parseLocation('', { city: 'Austin', region: 'TX', country: 'US' })).toMatchObject({ cityName: 'Austin', region: 'TX', country: 'US' });
    expect(parseLocation('Remote', { country: 'TW' })).toMatchObject({ country: 'TW', countrySource: 'hint', remoteScope: null });
    // The provider's stated country binds: a city the table has only elsewhere stays unplaced.
    expect(parseLocation('Tokyo', { country: 'US' })).toMatchObject({ city: null, cityName: 'Tokyo', country: 'US', countrySource: 'hint', lat: null });
    // The search's country is weaker: it never overrides a table city in another country.
    expect(parseLocation('Tokyo', { searchCountry: 'US' })).toMatchObject({ country: 'JP', countrySource: 'city_table' });
    expect(parseLocation('', { country: 'Atlantis' })).toMatchObject({ country: null });
    expect(parseLocation('Springfield', { region: 'IL', country: 'US' })).toMatchObject({ region: 'IL', country: 'US' });
  });

  it('reads countries from region and ISO codes when the city is unknown', () => {
    expect(parseLocation('Foo, ON, CA')).toMatchObject({ cityName: 'Foo', region: 'ON', country: 'CA' });
    expect(parseLocation('Foo, NSW')).toMatchObject({ cityName: 'Foo', region: 'NSW', country: 'AU' });
    expect(parseLocation('Foo, JP, Bar')).toMatchObject({ country: 'JP' });
    expect(parseLocation('全国')).toMatchObject({ cityName: null, country: null });
    expect(parseLocation('Remote, Fully remote')).toMatchObject({ workModel: 'remote', cityName: null });
  });

  it('collapses duplicate places in multi-location posts', () => {
    const list = parseLocations(['Austin, TX', 'Austin, Texas, United States', 'Remote', '', null, 'Seattle, WA']);
    expect(list.map((p) => p.city?.id ?? p.workModel)).toEqual(['us-austin', 'remote', 'us-seattle']);
  });
});

describe('buildCityTableFromGeoNames', () => {
  const row = (id: number, name: string, ascii: string, lat: number, lng: number, cls: string, cc: string, admin1: string, pop: number) =>
    [id, name, ascii, '', lat, lng, cls, 'PPL', cc, '', admin1, '', '', '', pop, '', '', 'UTC', '2026-01-01'].join('\t');
  const tsv = [
    row(1, 'Austin', 'Austin', 30.26715, -97.74306, 'P', 'US', 'TX', 960000),
    row(2, 'Portland', 'Portland', 45.52345, -122.67621, 'P', 'US', 'OR', 650000),
    row(3, 'Portland', 'Portland', 43.66147, -70.25533, 'P', 'US', 'ME', 68000),
    row(4, 'São Paulo', 'Sao Paulo', -23.5475, -46.63611, 'P', 'BR', '27', 10000000),
    row(5, 'Tiny', 'Tiny', 1, 1, 'P', 'US', 'TX', 100),
    row(6, 'Lake', 'Lake', 1, 1, 'H', 'US', 'TX', 100000),
    'short\tline',
    '',
  ].join('\n');

  it('keeps populated places above the threshold, largest first, with unique ids and the GeoNames licence', () => {
    const seed: CityTable = { version: 1, asOf: '', source: CITY_TABLE_SOURCE, cities: [cityById('us-austin')!] };
    const t = buildCityTableFromGeoNames(tsv, { asOf: '2026-10-10', seed });
    expect(t.source).toEqual(GEONAMES_SOURCE);
    expect(t.version).toBe(2);
    expect(t.cities.map((c) => c.id)).toEqual(['br-sao-paulo', 'us-austin', 'us-portland', 'us-portland-me']);
    expect(t.cities[1]).toMatchObject({ zh: '奥斯汀', region: 'TX', lat: 30.27, lng: -97.74 });
    expect(t.cities[0]).toMatchObject({ name: 'São Paulo', aliases: ['Sao Paulo'] });
    expect(t.cities[0].region).toBeUndefined();
    expect(validateCityTable(t, COUNTRY_CODES)).toEqual([]);
  });

  it('carries the seed\'s aliases and non-US regions over to GeoNames rows', () => {
    const seed: CityTable = { version: 3, asOf: '', source: CITY_TABLE_SOURCE, cities: [cityById('in-bengaluru')!] };
    const t = buildCityTableFromGeoNames(row(9, 'Bengaluru', '', 12.97194, 77.59369, 'P', 'IN', '19', 8000000), { asOf: 'x', seed });
    expect(t.cities[0]).toMatchObject({ id: 'in-bengaluru', aliases: ['Bangalore'], region: 'KA', zh: '班加罗尔' });
    expect(t.version).toBe(4);
  });

  it('filters by country and population, and numbers colliding ids without a region', () => {
    const t = buildCityTableFromGeoNames([row(1, 'Twin', 'Twin', 0, 0, 'P', 'BR', '1', 50000), row(2, 'Twin', 'Twin', 0, 0, 'P', 'BR', '2', 40000), tsv].join('\n'), {
      asOf: 'x',
      countries: ['br'],
      minPopulation: 20000,
    });
    expect(t.cities.map((c) => c.id)).toEqual(['br-sao-paulo', 'br-twin', 'br-twin-2']);
    expect(t.version).toBe(1);
  });
});

describe('review regressions: locations', () => {
  it('resolves ambiguous names inside the provider\'s country and region', () => {
    expect(parseLocation('Cambridge', { country: 'GB' })).toMatchObject({ city: expect.objectContaining({ id: 'gb-cambridge' }), country: 'GB', region: 'England' });
    expect(parseLocation('Birmingham', { country: 'US', region: 'AL' })).toMatchObject({ city: expect.objectContaining({ id: 'us-birmingham' }), country: 'US', region: 'AL' });
    expect(parseLocation('Portland', { country: 'US', region: 'ME' })).toMatchObject({ city: null, cityName: 'Portland', region: 'ME', country: 'US', lat: null });
    expect(parseLocation('Cambridge', { searchCountry: 'GB' })).toMatchObject({ city: expect.objectContaining({ id: 'gb-cambridge' }) });
    expect(parseLocation('Cambridge')).toMatchObject({ city: expect.objectContaining({ id: 'us-cambridge' }) });
    // Text that names a region code still rules over the hint.
    expect(parseLocation('Toronto, ON', { searchCountry: 'US' })).toMatchObject({ city: expect.objectContaining({ id: 'ca-toronto' }), country: 'CA' });
  });

  it('reads "<subdivision>, <country>" as a state-level location, except city-level subdivisions', () => {
    expect(parseLocation('Washington, United States')).toMatchObject({ city: null, cityName: null, region: 'WA', country: 'US', lat: null });
    expect(parseLocation('New York, United States')).toMatchObject({ city: null, cityName: null, region: 'NY', country: 'US' });
    expect(parseLocation('California, United States')).toMatchObject({ city: null, region: 'CA', country: 'US' });
    expect(parseLocation('Texas, US')).toMatchObject({ city: null, region: 'TX', country: 'US' });
    expect(parseLocation('England, United Kingdom')).toMatchObject({ city: null, region: 'England', country: 'GB' });
    expect(parseLocation('Beijing, China')).toMatchObject({ city: expect.objectContaining({ id: 'cn-beijing' }), country: 'CN' });
    expect(parseLocation('Delhi, India')).toMatchObject({ city: expect.objectContaining({ id: 'in-delhi' }), country: 'IN' });
    expect(parseLocation('Washington, DC, United States')).toMatchObject({ city: expect.objectContaining({ id: 'us-washington' }) });
  });

  it('scopes "remote/anywhere in <country>" to that country; global only when none is named', () => {
    expect(parseLocation('Anywhere in the US')).toMatchObject({ workModel: 'remote', country: 'US', remoteScope: 'US' });
    expect(parseLocation('Remote in Canada')).toMatchObject({ workModel: 'remote', cityName: null, country: 'CA', remoteScope: 'CA' });
    expect(parseLocation('Remote - Worldwide')).toMatchObject({ workModel: 'remote', country: null, remoteScope: 'global' });
    expect(parseLocation('Remote')).toMatchObject({ workModel: 'remote', remoteScope: null });
  });

  it('matches two-character district aliases only as a district, never inside Japanese place names', () => {
    expect(parseLocation('三重県')).toMatchObject({ city: null, country: null, lat: null });
    expect(parseLocation('三重県四日市市')).toMatchObject({ city: null, country: null });
    expect(parseLocation('新北市三重區')).toMatchObject({ city: expect.objectContaining({ id: 'tw-new-taipei' }) });
    expect(parseLocation('台北市內湖區')).toMatchObject({ city: expect.objectContaining({ id: 'tw-taipei' }) });
    expect(scanCjkCities('三重区')?.id).toBe('tw-new-taipei');
    expect(scanCjkCities('三重')?.id).toBe('tw-new-taipei');
    expect(scanCjkCities('新北三重')?.id).toBe('tw-new-taipei');
    expect(scanCjkCities('三重奏工作室')).toBeNull();
  });
});

describe('MKT-5F JT-7: the district of a Taiwan location', () => {
  // The strings are the shapes the research note measured on live sources (JOB_SOURCES_TW §5.3).
  it.each([
    ['新竹縣竹北市', 'tw-zhubei', '竹北市'],
    ['苗栗縣竹南鎮', 'tw-miaoli', '竹南鎮'],
    ['台中市西屯區', 'tw-taichung', '西屯區'],
    ['臺南市善化區', 'tw-tainan', '善化區'],
    ['臺北市士林區 • 透過「104人力銀行」', 'tw-taipei', '士林區'],
    ['臺北市信義區', 'tw-taipei', '信義區'],
    ['基隆市信義區', 'tw-keelung', '信義區'],
    ['台灣台北市內湖區', 'tw-taipei', '內湖區'],
    ['新北市新店區, 台灣', 'tw-new-taipei', '新店區'],
    ['Hybrid (新北市板橋區)', 'tw-new-taipei', '板橋區'],
    ['新竹市東區', 'tw-hsinchu', '東區'],
    ['嘉義市西區', 'tw-chiayi', '西區'],
  ])('ACCEPT: %s resolves to its county (%s) and district %s', (text, city, district) => {
    const p = parseLocation(text);
    expect(p).toMatchObject({ country: 'TW', district });
    expect(p.city?.id).toBe(city);
  });

  it('ACCEPT: 新竹縣竹北市 is county 新竹縣 and district 竹北市; the city and the region are what they were', () => {
    expect(parseLocation('新竹縣竹北市')).toMatchObject({ cityName: 'Zhubei', region: 'Hsinchu County', country: 'TW', countrySource: 'city_table', district: '竹北市' });
  });

  it('ACCEPT: 不限 means the whole county and gives no district; neither does a county alone', () => {
    for (const text of ['台中市不限', '桃園市不限', '臺北市不限', '台北市', '新竹縣', '新北市, 台灣']) {
      expect(parseLocation(text), text).toMatchObject({ country: 'TW', district: null });
    }
  });

  it('ACCEPT: a location outside Taiwan never gets a district', () => {
    for (const text of ['上海市静安区', '北京市朝阳区', '广东省深圳市南山区', 'Austin, TX', 'London, England, United Kingdom', '香港中西區', '東京都港区', 'Remote', 'Multiple Locations', '']) {
      const p = parseLocation(text);
      expect(p.country, text).not.toBe('TW');
      expect(p.district, text).toBeNull();
    }
  });

  it('a place written in English, a district the table does not have and two places in one text give no district: nothing is guessed', () => {
    for (const text of ['Taipei City, Taiwan', 'Zhubei, Hsinchu County, Taiwan', 'Neihu District, Taipei', '台北市某某區', '新北市, 台北市信義區']) {
      expect(parseLocation(text), text).toMatchObject({ country: 'TW', district: null });
    }
  });

  it('a county the city table does not hold needs the provider to say Taiwan (連江縣 is also a county of Fujian)', () => {
    expect(parseLocation('連江縣南竿鄉')).toMatchObject({ country: null, district: null });
    expect(parseLocation('連江縣南竿鄉', { country: 'TW' })).toMatchObject({ country: 'TW', countrySource: 'hint', district: '南竿鄉' });
    // The same text under another country is not a Taiwanese district.
    expect(parseLocation('連江縣南竿鄉', { country: 'CN' })).toMatchObject({ country: 'CN', district: null });
  });

  it('every district of the table parses back to itself, in the county\'s city, in both spellings of 台', () => {
    let checked = 0;
    for (const row of TW_DISTRICTS) {
      const county = TW_COUNTIES.find((c) => c.code === row.countyCode)!;
      const city = findCity(county.name, { country: 'TW' });
      for (const name of row.districts?.length ? row.districts : [row.district]) {
        for (const spelled of [county.name, county.nameAlt ?? county.name]) {
          const p = parseLocation(`${spelled}${name}`, city ? {} : { country: 'TW' });
          expect(p.district, `${spelled}${name}`).toBe(name);
          if (city) expect(p.city?.id, `${spelled}${name}`).toBe(city.id);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(700);
  });

  it('twDistrictOfText reads the whole text first, then each part; the first part that names a county decides', () => {
    expect(twDistrictOfText('新竹縣竹北市')).toBe('竹北市');
    expect(twDistrictOfText('台灣, 新竹縣竹北市')).toBe('竹北市');
    expect(twDistrictOfText('臺灣省臺中市西屯區')).toBe('西屯區');
    expect(twDistrictOfText('台中市不限 / 台北市信義區')).toBeNull();
    expect(twDistrictOfText('Hsinchu')).toBeNull();
    expect(twDistrictOfText('')).toBeNull();
  });
});

describe('MKT-5F: "Canton" alone is not Guangzhou (waveM4 carry-over)', () => {
  it('a line that is only "Canton" names no place in China; with a US state it is in the United States', () => {
    expect(parseLocation('Canton')).toMatchObject({ city: null, country: null });
    expect(parseLocation('Canton, MA')).toMatchObject({ city: null, cityName: 'Canton', region: 'MA', country: 'US' });
    expect(parseLocation('110 Albany Turnpike, Canton, CT 06019')).toMatchObject({ country: 'US' });
    expect(parseLocation('Canton, Michigan, United States')).toMatchObject({ country: 'US' });
    expect(findCity('Canton')).toBeNull();
  });

  it('China is still China when the text says so, and Guangzhou keeps every name of its own', () => {
    expect(parseLocation('Canton, China')).toMatchObject({ city: null, cityName: 'Canton', country: 'CN', countrySource: 'text', lat: null });
    for (const name of ['Guangzhou', '广州', '廣州', '广州市', 'Guangzhou, Guangdong, China', '广东省广州市天河区']) {
      expect(parseLocation(name).city?.id, name).toBe('cn-guangzhou');
    }
  });
});
