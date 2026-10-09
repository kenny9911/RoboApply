// server/src/features/jobs/data/index.ts — static reference data for the job
// normalizers (WP-16a) and the attribution list for /legal (WP-13 renders it).
//
// D3: every list here says where it came from. A list compiled by the team is
// labelled as such; a third-party dataset carries its licence and the
// attribution it requires.

import staffing from './staffing-agencies.json' with { type: 'json' };
import { CITY_TABLE_AS_OF, CITY_TABLE_SOURCE } from '../geo/index.js';
import { TAXONOMY_AS_OF, TAXONOMY_SOURCES } from '../taxonomy/index.js';

export interface DataSource {
  id: string;
  name: string;
  publisher: string;
  url: string | null;
  license: string;
  notes?: string;
}

interface StaffingFile {
  version: number;
  asOf: string;
  source: DataSource;
  agencies: string[];
}

const STAFFING = staffing as StaffingFile;

/** Company names (as published) of firms whose business is staffing, recruitment or executive search. */
export const STAFFING_AGENCY_NAMES: readonly string[] = STAFFING.agencies;
export const STAFFING_AGENCY_SOURCE: Readonly<DataSource> = STAFFING.source;
export const STAFFING_AGENCY_AS_OF = STAFFING.asOf;

export interface DataAttribution {
  /** What the data is used for, in plain words (shown on /legal). */
  usedFor: string;
  source: DataSource;
  asOf: string;
  /** True when the licence requires public attribution (e.g. CC BY). */
  attributionRequired: boolean;
}

const requiresAttribution = (license: string) => /\bCC BY\b/i.test(license);

/**
 * Every dataset the job pipeline ships with. /legal lists the entries with
 * `attributionRequired` (ARCH §4.4: GeoNames is CC BY once the city table is
 * regenerated from it; O*NET is CC BY).
 */
export function jobDataAttributions(): DataAttribution[] {
  return [
    {
      usedFor: 'City names and map positions for job locations',
      source: { ...CITY_TABLE_SOURCE },
      asOf: CITY_TABLE_AS_OF,
      attributionRequired: requiresAttribution(CITY_TABLE_SOURCE.license),
    },
    ...TAXONOMY_SOURCES.map((s) => ({
      usedFor: `Job role categories (${s.usedFor})`,
      source: { id: s.id, name: s.name, publisher: s.publisher, url: s.url, license: s.license },
      asOf: TAXONOMY_AS_OF,
      attributionRequired: requiresAttribution(s.license),
    })),
    {
      usedFor: 'Marking posts from staffing and recruitment firms',
      source: { ...STAFFING_AGENCY_SOURCE },
      asOf: STAFFING_AGENCY_AS_OF,
      attributionRequired: requiresAttribution(STAFFING_AGENCY_SOURCE.license),
    },
  ];
}
