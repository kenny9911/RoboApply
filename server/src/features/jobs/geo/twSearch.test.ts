// @vitest-environment node
//
// MKT-5F (JT-7): "is this search in Taiwan?" and the district filter's values.
// Pure functions over the two committed tables; no network, no database.
import { describe, expect, it } from 'vitest';
import {
  TW_COUNTIES,
  TW_DISTRICTS,
  findCity,
  isTaiwanPlace,
  isTaiwanSearch,
  resolveTwDistrictValue,
  twCountiesOfPlace,
  twCountyCityNames,
  twCountyKeys,
  twDistrictNameIsShared,
  twPlaceKey,
} from './index.js';

const names = (row: (typeof TW_DISTRICTS)[number]): string[] => (row.districts?.length ? row.districts : [row.district]);

describe('isTaiwanSearch', () => {
  it('a search is in Taiwan when its country is TW or one of its places is', () => {
    expect(isTaiwanSearch({ country: 'TW' })).toBe(true);
    expect(isTaiwanSearch({ country: 'tw' })).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: 'Taipei' }] })).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: 'Taipei, Taiwan', city: 'Taipei, Taiwan' }] })).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: '新竹縣' }] })).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: '臺北市信義區' }] })).toBe(true);
    expect(isTaiwanSearch({ locations: [{ label: 'Anywhere', country: 'TW' }] })).toBe(true);
    expect(isTaiwanSearch({ country: 'US', locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US' }, { label: '台中市' }] })).toBe(true);
    // 連江縣 is one of the 22 counties although the city table has no record for it.
    expect(isTaiwanSearch({ locations: [{ label: '連江縣' }] })).toBe(true);
  });

  it('ACCEPT: a United States search, an empty search and a place that states another country are not', () => {
    expect(isTaiwanSearch({ country: 'US' })).toBe(false);
    expect(isTaiwanSearch({ country: 'US', locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US' }] })).toBe(false);
    expect(isTaiwanSearch({ locations: [{ label: 'Tokyo' }, { label: 'Shanghai' }, { label: 'Remote' }] })).toBe(false);
    // The stated country binds: a place called Taipei that says US is not in Taiwan.
    expect(isTaiwanSearch({ locations: [{ label: 'Taipei', country: 'US' }] })).toBe(false);
    expect(isTaiwanPlace({ label: '台北市', country: 'CN' })).toBe(false);
    expect(isTaiwanSearch({})).toBe(false);
    expect(isTaiwanSearch(null)).toBe(false);
    expect(isTaiwanSearch(undefined)).toBe(false);
  });
});

describe('twCountiesOfPlace', () => {
  const of = (label: string, country?: string) => twCountiesOfPlace({ label, ...(country ? { country } : {}) }).map((c) => c.name);

  it('reads a county from its own name in either spelling, and from the city the table gives it', () => {
    expect(of('台北市')).toEqual(['台北市']);
    expect(of('臺北市')).toEqual(['台北市']);
    expect(of('Taipei')).toEqual(['台北市']);
    expect(of('Taipei City, Taiwan')).toEqual(['台北市']);
    expect(of('新竹縣竹北市')).toEqual(['新竹縣']);
    expect(of('Hsinchu County')).toEqual(['新竹縣']);
    expect(of('Hsinchu')).toEqual(['新竹市']);
    expect(of('連江縣')).toEqual(['連江縣']);
  });

  it('one city record can stand for two counties; a county\'s own name still means that county alone', () => {
    expect(of('Chiayi')).toEqual(['嘉義市', '嘉義縣']);
    expect(of('嘉義市')).toEqual(['嘉義市']);
    expect(of('嘉義縣')).toEqual(['嘉義縣']);
  });

  it('is empty for a place outside Taiwan or one that states another country', () => {
    expect(of('Austin, TX')).toEqual([]);
    expect(of('上海')).toEqual([]);
    expect(of('Taipei', 'US')).toEqual([]);
    expect(of('')).toEqual([]);
  });
});

describe('resolveTwDistrictValue: the district filter\'s values', () => {
  it('every (county, district) of the table resolves to itself, in both spellings of 台', () => {
    let checked = 0;
    for (const row of TW_DISTRICTS) {
      const county = TW_COUNTIES.find((c) => c.code === row.countyCode)!;
      for (const name of names(row)) {
        for (const spelled of [county.name, county.nameAlt ?? county.name]) {
          expect(resolveTwDistrictValue(`${spelled}${name}`), `${spelled}${name}`).toEqual({ countyCode: row.countyCode, county: county.name, district: name, zip3: row.zip3, value: `${county.name}${name}` });
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(700);
  });

  it('a bare district name is taken only when one county alone has it', () => {
    expect(resolveTwDistrictValue('竹北市')).toMatchObject({ county: '新竹縣', district: '竹北市', value: '新竹縣竹北市' });
    expect(resolveTwDistrictValue(' 西屯區 ')).toMatchObject({ county: '台中市', value: '台中市西屯區' });
    for (const shared of ['東區', '北區', '中正區', '信義區', '中山區', '大安區']) expect(resolveTwDistrictValue(shared), shared).toBeNull();
  });

  it('anything that is not a district of the table is null: a county alone, 不限, extra text, free text, nothing', () => {
    for (const value of ['台中市', '台中市不限', '台北市士林區x', '台北市某某區', 'Neihu', 'Taipei', '上海市静安区', '', '   ', null, undefined, 7 as unknown as string]) {
      expect(resolveTwDistrictValue(value), String(value)).toBeNull();
    }
  });

  it('knows which district names more than one county has (measured on the committed table)', () => {
    const counties = new Map<string, Set<string>>();
    for (const row of TW_DISTRICTS) for (const name of names(row)) counties.set(name, new Set([...(counties.get(name) ?? []), row.county]));
    const shared = [...counties.entries()].filter(([, set]) => set.size > 1).map(([name]) => name).sort();
    expect(shared).toEqual(['中山區', '中正區', '信義區', '北區', '南區', '大安區', '東區', '西區'].sort());
    for (const name of counties.keys()) expect(twDistrictNameIsShared(name), name).toBe(shared.includes(name));
    expect([...counties.get('東區')!].sort()).toEqual(['台中市', '台南市', '嘉義市', '新竹市'].sort());
    expect([...counties.get('信義區')!].sort()).toEqual(['台北市', '基隆市'].sort());
    expect(twDistrictNameIsShared('竹北市')).toBe(false);
  });
});

describe('twCountyCityNames: the city a job row of the county is stored under', () => {
  it('gives the names of the county\'s city record, lower-cased; none for the one county the table does not hold', () => {
    expect(twCountyCityNames('01')).toEqual(expect.arrayContaining(['taipei', '台北', '臺北', '台北市']));
    expect(twCountyCityNames('11')).toEqual(expect.arrayContaining(['keelung', '基隆']));
    expect(twCountyCityNames('34')).toEqual(expect.arrayContaining(['zhubei', '新竹縣']));
    expect(twCountyCityNames('24')).toEqual([]);
    expect(twCountyCityNames('99')).toEqual([]);
  });

  it('every county that shares a district name with another has a city record, and two such counties never share one', () => {
    const sharing = new Map<string, string[]>();
    for (const row of TW_DISTRICTS) for (const name of names(row)) if (twDistrictNameIsShared(name)) sharing.set(name, [...(sharing.get(name) ?? []), row.countyCode]);
    expect(sharing.size).toBe(8);
    for (const [name, codes] of sharing) {
      const records = codes.map((code) => findCity(TW_COUNTIES.find((c) => c.code === code)!.name, { country: 'TW' })?.id ?? null);
      expect(records.every(Boolean), name).toBe(true);
      // The pair (city, district) tells them apart only when each county has a city of its own.
      expect(new Set(records).size, name).toBe(codes.length);
    }
  });
});

describe('twCountyKeys: what a client matches a typed place against', () => {
  it('holds the county\'s own names and its city\'s names, folded the way a typed label is', () => {
    const taipei = TW_COUNTIES.find((c) => c.code === '01')!;
    expect(twCountyKeys(taipei)).toEqual(expect.arrayContaining(['台北市', 'taipei', 'taipei city', '台北']));
    expect(twCountyKeys(taipei)).toContain(twPlaceKey('臺北市'));
    expect(twCountyKeys(taipei)).toContain(twPlaceKey('  Taipei   City '));
    expect(twCountyKeys(TW_COUNTIES.find((c) => c.code === '24')!)).toEqual(['連江縣']);
  });

  it('a county\'s own name is never a key of another county (嘉義市 and 嘉義縣 share a city record)', () => {
    const keys = new Map(TW_COUNTIES.map((c) => [c.name, twCountyKeys(c)] as const));
    for (const county of TW_COUNTIES) {
      for (const [other, list] of keys) {
        if (other !== county.name) expect(list, `${other} must not answer to ${county.name}`).not.toContain(twPlaceKey(county.name));
      }
    }
    expect(keys.get('嘉義市')).toContain('chiayi');
    expect(keys.get('嘉義縣')).toContain('chiayi');
  });
});
