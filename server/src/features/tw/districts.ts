// server/src/features/tw/districts.ts — the 22 counties with their districts,
// for the district filter (MKT-5F; MARKET_STRATEGY §9.5 JT-7).
//
// A read of the committed district table (jobs/geo: the open-data interface's
// county codes and 中華郵政's postal list, with its source block), shaped for
// the filters drawer. Names are data in Traditional Chinese for every locale;
// nothing here is UI copy and nothing is computed from job rows. The postal
// list is open data under 政府資料開放授權條款 第1版, which asks for attribution
// wherever it is reused: the answer carries the table's own attribution
// sentence and the licence link, and the district picker prints them.

import {
  TW_COUNTIES,
  TW_DISTRICTS_AS_OF,
  TW_DISTRICTS_SOURCE,
  districtsOfCounty,
  twCountyKeys,
  type TwDistrict,
} from '../jobs/geo/index.js';
import type { TwCountyView, TwDistrictView, TwDistrictsResponse } from './contract.js';

/** One row of the postal list can carry several districts (新竹市 300: 東區, 北區, 香山區). */
function districtViews(row: TwDistrict): TwDistrictView[] {
  const names = row.districts?.length ? row.districts : [row.district];
  const english = row.districts?.length ? (row.ens ?? []) : [row.en];
  return names.map((name, i) => ({ name, value: `${row.county}${name}`, zip3: row.zip3, en: english[i] ?? null }));
}

let cached: TwDistrictsResponse | null = null;

/** The whole table. Built once: the tables are constants of the build. */
export function twDistrictsResponse(): TwDistrictsResponse {
  if (cached) return cached;
  const counties: TwCountyView[] = TW_COUNTIES.map((county) => ({
    code: county.code,
    name: county.name,
    nameAlt: county.nameAlt,
    keys: twCountyKeys(county),
    districts: districtsOfCounty(county.code).flatMap(districtViews),
  }));
  const { name, publisher, url, license, licenseUrl, retrievedOn, attribution } = TW_DISTRICTS_SOURCE;
  cached = {
    asOf: TW_DISTRICTS_AS_OF,
    source: { name, publisher, url, license, licenseUrl: licenseUrl?.trim() || null, retrievedOn, attribution: attribution?.trim() || null },
    counties,
  };
  return cached;
}
