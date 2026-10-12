// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CITY_TABLE_SOURCE } from '../geo/index.js';
import {
  DOL_LCA_SOURCE,
  DOL_LCA_URL,
  STAFFING_AGENCY_NAMES,
  STAFFING_AGENCY_SOURCE,
  UK_SPONSOR_REGISTER_LICENCE,
  UK_SPONSOR_REGISTER_URL,
  USCIS_H1B_HUB_URL,
  jobDataAttributions,
  sponsorshipDataSource,
  sponsorshipDataSources,
} from './index.js';
import { LCA_SOURCE } from './lca.js';

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

describe('sponsorship records: the three publications behind the company facts (JI-11)', () => {
  it('names each publication, its publisher, its public page and its importer', () => {
    const sources = sponsorshipDataSources();
    expect(sources.map((s) => s.kind)).toEqual(['dol_lca', 'uscis_h1b_hub', 'uk_sponsor_register']);
    expect(sources.map((s) => [s.citation, s.url, s.country, s.table])).toEqual([
      ['US Department of Labor, LCA disclosure data', DOL_LCA_URL, 'US', 'RAH1bEmployerStat'],
      ['US Citizenship and Immigration Services, H-1B Employer Data Hub', USCIS_H1B_HUB_URL, 'US', 'RASponsorRegisterEntry'],
      ['UK Visas and Immigration, Register of licensed sponsors: workers', UK_SPONSOR_REGISTER_URL, 'GB', 'RASponsorRegisterEntry'],
    ]);
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const s of sources) {
      expect(s.citation).toBe(`${s.publisher}, ${s.name}`);
      // A page, never a file: the owner picks the file there.
      expect(s.url).toMatch(/^https:\/\/(www\.dol\.gov|www\.uscis\.gov|www\.gov\.uk)\//);
      expect(s.url).not.toMatch(/\.(csv|xlsx?)$/i);
      expect(s.usedFor.length).toBeGreaterThan(20);
      expect(s.license.length).toBeGreaterThan(10);
      // The command that fills the table exists. The two register importers write only with --apply; the LCA
      // importer (older than this wave, unchanged) writes unless --dry-run is given.
      const importer = readFileSync(path.resolve(here, '../../../../..', s.importer), 'utf8');
      if (s.table === 'RASponsorRegisterEntry') expect(importer, s.importer).toMatch(/WITHOUT --apply NOTHING IS WRITTEN/);
      else expect(importer, s.importer).toContain('--dry-run');
    }
    expect(sponsorshipDataSource('uscis_h1b_hub').name).toBe('H-1B Employer Data Hub');
    // One id for the LCA figures, wherever it is written.
    expect(DOL_LCA_SOURCE).toBe(LCA_SOURCE);
  });

  it('only the UK register asks for an acknowledgement: the Open Government Licence statement and link', () => {
    const [lca, uscis, uk] = sponsorshipDataSources();
    expect(lca!.attribution).toBeNull();
    expect(uscis!.attribution).toBeNull();
    expect(uk!.license).toBe('Open Government Licence v3.0');
    expect(uk!.attribution).toEqual({ text: UK_SPONSOR_REGISTER_LICENCE.statement, url: UK_SPONSOR_REGISTER_LICENCE.url });
  });

  it('they are not datasets we ship: no copy and no copy date, so they are not rows of jobDataAttributions()', () => {
    const shipped = jobDataAttributions().map((a) => a.source.id);
    for (const s of sponsorshipDataSources()) expect(shipped).not.toContain(s.kind);
    // No government file is in the repository: the fixtures say so and hold placeholders only.
    const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
    expect(readFileSync(path.join(fixtures, 'README.md'), 'utf8')).toMatch(/Every file here is SYNTHETIC/);
    for (const file of ['uscis.sample.csv', 'uk-sponsors.sample.csv']) {
      const names = readFileSync(path.join(fixtures, file), 'utf8')
        .split('\n')
        .slice(1)
        .map((l) => (l.split(',')[file.startsWith('uscis') ? 1 : 0] ?? '').replace(/"/g, ''))
        .filter(Boolean);
      expect(names.length).toBeGreaterThan(3);
      for (const name of names) expect(name, file).toMatch(/^(example|sample|placeholder) /i);
    }
  });

  it('index.ts imports nothing that loads normalize/ (normalize/agency.ts reads index.ts while normalize/ is loading)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const specifiers = (file: string) => [...readFileSync(path.join(here, file), 'utf8').matchAll(/^(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers('index.ts').sort()).toEqual(['../geo/index.js', '../taxonomy/index.js', './sponsorSources.js', './sponsorSources.js', './staffing-agencies.json'].sort());
    expect(specifiers('sponsorSources.ts')).toEqual([]);
  });
});
