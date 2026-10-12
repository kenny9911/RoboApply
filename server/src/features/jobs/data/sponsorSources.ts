// server/src/features/jobs/data/sponsorSources.ts — the three government
// publications behind the company sponsorship facts (JI-11): what each is
// called, who publishes it, where its page is and what its licence asks for.
//
// One definition for the importers' `sourceUrl`, the names the facts route
// prints and any page that lists our sources. No copy of these publications
// ships in the repository: the owner downloads a file and imports it
// (importLca.ts, importUscis.ts, importUkSponsors.ts), and every stored row
// carries its own file name and date. They therefore have no "copy date", and
// on a deployment where nothing was imported they are not in use, which is why
// they are not rows of `jobDataAttributions()` (index.ts: the datasets that DO
// ship).
//
// This module imports nothing, on purpose: index.ts re-exports it, and
// normalize/agency.ts reads index.ts while normalize/ is still loading, so
// nothing reachable from index.ts may import normalize/ (lca.ts, uscis.ts and
// ukSponsors.ts do, and are not imported by index.ts).
//
// Names, addresses and the licence were read from the publishers' pages on
// 2026-10-12 (the loaders' headers say which page gave what).

/** `source` of the DOL LCA figures (lca.ts `LCA_SOURCE`; a test holds the two equal). */
export const DOL_LCA_SOURCE = 'dol_lca' as const;
export const USCIS_H1B_HUB_SOURCE = 'uscis_h1b_hub' as const;
export const UK_SPONSOR_REGISTER_SOURCE = 'uk_sponsor_register' as const;

/** `RASponsorRegisterEntry.source`. */
export type SponsorRegisterSource = typeof USCIS_H1B_HUB_SOURCE | typeof UK_SPONSOR_REGISTER_SOURCE;
export type SponsorshipDataKind = typeof DOL_LCA_SOURCE | SponsorRegisterSource;

/** US DOL OFLC performance data page (the LCA disclosure files' home). */
export const DOL_LCA_URL = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
/** The hub's public page: `sourceUrl` of every hub row. */
export const USCIS_H1B_HUB_URL = 'https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub';
/** The register's public page: `sourceUrl` of every register row. */
export const UK_SPONSOR_REGISTER_URL = 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';

export const USCIS_COUNTRY = 'US';
export const UK_SPONSOR_REGISTER_COUNTRY = 'GB';

/**
 * Open Government Licence v3.0, the licence of the UK register's page: the
 * statement the licence gives for a provider that names none, and the
 * licence's address.
 */
export const UK_SPONSOR_REGISTER_LICENCE = {
  name: 'Open Government Licence v3.0',
  url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  statement: 'Contains public sector information licensed under the Open Government Licence v3.0.',
} as const;

/** Joins the distinct "Type & Rating" values of one organisation in `RASponsorRegisterEntry.rating`. */
export const UK_RATING_SEPARATOR = '; ';

/** 2025 → 'FY2025', the `period` of a hub row. */
export function uscisPeriod(fiscalYear: number): string {
  return `FY${fiscalYear}`;
}

/** 'FY2025' → 2025; null for anything else. */
export function fiscalYearOfPeriod(period: string): number | null {
  const m = period.match(/^FY(\d{4})$/);
  return m ? Number(m[1]) : null;
}

export interface SponsorshipDataSource {
  /** The fact kind this publication feeds, and `source` of its stored rows. */
  kind: SponsorshipDataKind;
  /** The publication's own title. */
  name: string;
  publisher: string;
  /** The publication's public page (never a file). */
  url: string;
  /** ISO alpha-2 of the country the record is about. */
  country: string;
  /** How a fact names its source: "{publisher}, {name}". */
  citation: string;
  /** What we use it for, in plain words. */
  usedFor: string;
  /** The licence as its page states it, or what kind of publication it is where the page states none. */
  license: string;
  /**
   * The acknowledgement the licence asks for wherever the information is
   * shown, with the licence's address; null when it asks for none. The reader
   * prints it with the fact.
   */
  attribution: { text: string; url: string } | null;
  /** The table the importer writes and the command that fills it. */
  table: 'RAH1bEmployerStat' | 'RASponsorRegisterEntry';
  importer: string;
}

const US_AGENCY_RECORD = 'Public record published by a US federal agency (its page states no licence)';

function source(input: Omit<SponsorshipDataSource, 'citation'>): SponsorshipDataSource {
  return { ...input, citation: `${input.publisher}, ${input.name}` };
}

/** The publications behind the company sponsorship facts, in the order the facts are listed. */
export function sponsorshipDataSources(): SponsorshipDataSource[] {
  return [
    source({
      kind: DOL_LCA_SOURCE,
      name: 'LCA disclosure data',
      publisher: 'US Department of Labor',
      url: DOL_LCA_URL,
      country: 'US',
      usedFor: 'H-1B labor condition applications certified for an employer, by fiscal year',
      license: US_AGENCY_RECORD,
      attribution: null,
      table: 'RAH1bEmployerStat',
      importer: 'server/src/features/jobs/data/importLca.ts',
    }),
    source({
      kind: USCIS_H1B_HUB_SOURCE,
      name: 'H-1B Employer Data Hub',
      publisher: 'US Citizenship and Immigration Services',
      url: USCIS_H1B_HUB_URL,
      country: USCIS_COUNTRY,
      usedFor: 'H-1B petitions approved and denied for an employer, by fiscal year',
      license: US_AGENCY_RECORD,
      attribution: null,
      table: 'RASponsorRegisterEntry',
      importer: 'server/src/features/jobs/data/importUscis.ts',
    }),
    source({
      kind: UK_SPONSOR_REGISTER_SOURCE,
      name: 'Register of licensed sponsors: workers',
      publisher: 'UK Visas and Immigration',
      url: UK_SPONSOR_REGISTER_URL,
      country: UK_SPONSOR_REGISTER_COUNTRY,
      usedFor: 'Whether an organisation holds a UK licence to sponsor workers, with its type, rating and routes',
      license: UK_SPONSOR_REGISTER_LICENCE.name,
      attribution: { text: UK_SPONSOR_REGISTER_LICENCE.statement, url: UK_SPONSOR_REGISTER_LICENCE.url },
      table: 'RASponsorRegisterEntry',
      importer: 'server/src/features/jobs/data/importUkSponsors.ts',
    }),
  ];
}

/** One publication by its kind (every kind has one). */
export function sponsorshipDataSource(kind: SponsorshipDataKind): SponsorshipDataSource {
  return sponsorshipDataSources().find((s) => s.kind === kind)!;
}
