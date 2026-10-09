// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CITY_TABLE_SOURCE } from '../geo/index.js';
import { STAFFING_AGENCY_NAMES, STAFFING_AGENCY_SOURCE, jobDataAttributions } from './index.js';

describe('job reference data', () => {
  it('ships a staffing-firm list with its source and no duplicates', () => {
    expect(STAFFING_AGENCY_NAMES.length).toBeGreaterThan(40);
    expect(new Set(STAFFING_AGENCY_NAMES).size).toBe(STAFFING_AGENCY_NAMES.length);
    expect(STAFFING_AGENCY_SOURCE).toMatchObject({ id: 'roboapply_staffing_list', publisher: 'RoboApply' });
    expect(STAFFING_AGENCY_SOURCE.notes).toMatch(/publicly describes/);
  });

  it('lists every dataset with its licence; CC BY sources require attribution on /legal', () => {
    const list = jobDataAttributions();
    // The city table comes first, whichever source it was built from (the seed today, GeoNames after buildCities.ts).
    expect(list[0].usedFor).toMatch(/City names/);
    expect(list[0].source.id).toBe(CITY_TABLE_SOURCE.id);
    expect(list.map((a) => a.source.id)).toEqual(expect.arrayContaining(['onet_soc_2019', 'roboapply_staffing_list']));
    expect(list.find((a) => a.source.id === 'onet_soc_2019')!.attributionRequired).toBe(true);
    for (const a of list) {
      // attributionRequired follows the licence, never the id.
      expect(a.attributionRequired).toBe(/\bCC BY\b/i.test(a.source.license));
      expect(a.source.license.length).toBeGreaterThan(5);
      expect(a.usedFor).toBeTruthy();
      expect(a.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
