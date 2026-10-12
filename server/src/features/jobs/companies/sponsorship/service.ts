// server/src/features/jobs/companies/sponsorship/service.ts — a company's
// sponsorship facts: every number with its year, source and date (JI-11).
//
// Three public records, read from two tables the owner fills with the
// importers of jobs/data:
//   dol_lca              RAH1bEmployerStat (importLca.ts): certified H-1B
//                        labor condition applications per fiscal year
//   uscis_h1b_hub        RASponsorRegisterEntry (importUscis.ts): H-1B
//                        petitions approved and denied per fiscal year
//   uk_sponsor_register  RASponsorRegisterEntry (importUkSponsors.ts): the
//                        organisation's licence, with its rating and routes
//
// Rules (D3; contract.ts says what a fact is and is not):
//   - the company is matched to a record by an EXACT match of its normalised
//     name (RACompany.nameNormalized, the key every importer writes with
//     `normalizeCompanyName`). No prefix, no similarity, no alias: a company
//     with no row has an empty list and nothing is inferred from that;
//   - at most five fiscal years per US source, the most recent first;
//   - a row that lacks a count it should carry is left out, never read as 0;
//   - the names, pages and licence lines of the sources come from one place
//     (jobs/data `sponsorshipDataSources`);
//   - a mainland company has no facts: none of these registers concerns it
//     (the route is off for GoApply anyway).
//
// `viewerNeedsSponsorship` says whether the signed-in viewer needs sponsorship
// in the country of the job the facts are shown on. It is the rule the feed's
// sponsorship badges use (feed/items.ts `needsSponsorshipFor`: the per-country
// work-authorisation answer when it says something, else the search profile's
// "I need visa sponsorship"), restated in `needsSponsorshipIn` because that
// function is not on the feed's public surface; sponsorship.test.ts holds the
// two equal. It only decides whether the job page opens the block; it never
// adds, removes or changes a fact.

import type prisma from '../../../../lib/prisma.js';
import type { Market } from '../../../../platform/brand/index.js';
import { logger } from '../../../../services/LoggerService.js';
import {
  DOL_LCA_SOURCE,
  UK_SPONSOR_REGISTER_COUNTRY,
  UK_SPONSOR_REGISTER_SOURCE,
  USCIS_COUNTRY,
  USCIS_H1B_HUB_SOURCE,
  fiscalYearOfPeriod,
  sponsorshipDataSource,
  sponsorshipDataSources,
  type SponsorshipDataKind,
  type SponsorshipDataSource,
} from '../../data/index.js';
import { findCompanyRow } from '../service.js';
import {
  SPONSORSHIP_DISCLAIMER,
  SPONSORSHIP_YEARS_PER_SOURCE,
  type CompanySponsorshipResponse,
  type DolLcaFact,
  type SponsorshipFact,
  type SponsorshipFactSource,
  type UkSponsorRegisterFact,
  type UscisH1bHubFact,
} from './contract.js';

export type SponsorshipDb = Pick<typeof prisma, 'rACompany' | 'rAH1bEmployerStat' | 'rASponsorRegisterEntry' | 'rAJob'>;

/** What the viewer's own answers say about sponsorship (the two fields of the match user the feed's rule reads). */
export interface SponsorshipNeed {
  /** The search profile's "I need visa sponsorship"; null when not answered. */
  needsSponsorship: boolean | null;
  /** Per-country work-authorisation answers from the profile. */
  workAuth: ReadonlyArray<{ country: string; sponsorship?: 'now' | 'later' | 'no' | null }>;
}

/**
 * Does the viewer need sponsorship in this country? The feed's badge rule: the
 * profile's answer for the job's country when it gives one, else the search
 * profile's answer. No viewer, or no answer, is "no".
 */
export function needsSponsorshipIn(user: SponsorshipNeed | null, country: string | null): boolean {
  if (!user) return false;
  const entry = country ? user.workAuth.find((w) => w.country === country) : undefined;
  if (entry && entry.sponsorship) return entry.sponsorship === 'now' || entry.sponsorship === 'later';
  return user.needsSponsorship === true;
}

/** Who is reading, and on which job page. */
export interface SponsorshipViewer {
  /** Null without a session. */
  userId: string | null;
  /** The job the facts are shown on; its country decides `viewerNeedsSponsorship`. */
  jobId?: string | null;
}

export interface SponsorshipServiceDeps {
  /**
   * The viewer's sponsorship answers (production: the match user, the object
   * the feed hands to its badge rule). Absent: nobody is treated as needing
   * sponsorship.
   */
  viewerNeed?: (userId: string) => Promise<SponsorshipNeed | null>;
}

/** The match area's user context, loaded on first use (it brings the scorer with it). */
export async function matchViewerNeed(userId: string): Promise<SponsorshipNeed | null> {
  const { matchService } = await import('../../../match/index.js');
  const { user } = await matchService.userContext(userId);
  return { needsSponsorship: user.needsSponsorship, workAuth: user.workAuth };
}

export interface SponsorshipService {
  /** `viewer` defaults to anonymous. 404 `company_not_found` for a company that is not this market's. */
  facts(market: Market, idOrSlug: string, viewer?: SponsorshipViewer): Promise<CompanySponsorshipResponse>;
}

interface LcaRow {
  fiscalYear: number;
  certifiedCount: number;
  sourceFile: string;
  importedAt: Date;
}

interface RegisterRow {
  employerName: string;
  period: string;
  approvals: number | null;
  denials: number | null;
  town: string | null;
  rating: string | null;
  routes: string[];
  sourceFile: string;
  sourceUrl: string;
  asOf: Date;
}

const REGISTER_SELECT = { employerName: true, period: true, approvals: true, denials: true, town: true, rating: true, routes: true, sourceFile: true, sourceUrl: true, asOf: true } as const;

function sourceOf(kind: SponsorshipDataKind, row: { sourceFile: string; sourceUrl?: string | null }, asOf: Date, dated: SponsorshipFactSource['dated']): SponsorshipFactSource {
  const publication = sponsorshipDataSource(kind);
  return {
    name: publication.citation,
    // The page the row itself was imported from; the publication's page for a table that stores none.
    url: row.sourceUrl || publication.url,
    sourceFile: row.sourceFile,
    asOf: asOf.toISOString(),
    dated,
    ...(publication.attribution ? { attribution: { ...publication.attribution } } : {}),
  };
}

/** Pure: a DOL LCA row → its fact. `asOf` is the day the file was imported (the table holds no publication date). */
export function toDolLcaFact(row: LcaRow): DolLcaFact {
  return { kind: 'dol_lca', fiscalYear: row.fiscalYear, certifiedCount: row.certifiedCount, source: sourceOf(DOL_LCA_SOURCE, row, row.importedAt, 'imported') };
}

/** Pure: a hub row → its fact, or null for a row without a fiscal year or without both counts (never read as 0). */
export function toUscisFact(row: RegisterRow): UscisH1bHubFact | null {
  const fiscalYear = fiscalYearOfPeriod(row.period);
  if (fiscalYear === null || row.approvals === null || row.denials === null) return null;
  return { kind: 'uscis_h1b_hub', fiscalYear, approvals: row.approvals, denials: row.denials, employerName: row.employerName, source: sourceOf(USCIS_H1B_HUB_SOURCE, row, row.asOf, 'published') };
}

/** Pure: a register row → its fact. */
export function toUkRegisterFact(row: RegisterRow): UkSponsorRegisterFact {
  return {
    kind: 'uk_sponsor_register',
    town: row.town || null,
    rating: row.rating || null,
    routes: [...(row.routes ?? [])],
    employerName: row.employerName,
    source: sourceOf(UK_SPONSOR_REGISTER_SOURCE, row, row.asOf, 'published'),
  };
}

const EMPTY = (): CompanySponsorshipResponse => ({ facts: [], disclaimer: SPONSORSHIP_DISCLAIMER, viewerNeedsSponsorship: false });

/** A publication the owner has imported at least one file of, with the date of its newest rows. */
export interface SponsorshipSourceInUse extends SponsorshipDataSource {
  /** ISO instant: the newest `asOf` of its rows (the newest import day for the DOL LCA table). */
  asOf: string;
  dated: SponsorshipFactSource['dated'];
}

/**
 * The sponsorship publications this database holds rows of, in the order the
 * facts are listed. For a page that lists our data sources (/legal): a
 * publication is "in use" only once a file of it was imported, and its date is
 * the date of those rows, never a date written in code. Empty on a deployment
 * where nothing was imported. Three small reads; cache the answer where the
 * page is public.
 */
export async function sponsorshipSourcesInUse(db: Pick<SponsorshipDb, 'rAH1bEmployerStat' | 'rASponsorRegisterEntry'>): Promise<SponsorshipSourceInUse[]> {
  const newestOf = (source: string) =>
    db.rASponsorRegisterEntry.findFirst({ where: { source }, orderBy: { asOf: 'desc' }, select: { asOf: true } }) as Promise<{ asOf: Date } | null>;
  const [lca, hub, register] = await Promise.all([
    db.rAH1bEmployerStat.findFirst({ orderBy: { importedAt: 'desc' }, select: { importedAt: true } }) as Promise<{ importedAt: Date } | null>,
    newestOf(USCIS_H1B_HUB_SOURCE),
    newestOf(UK_SPONSOR_REGISTER_SOURCE),
  ]);
  const newest: Record<SponsorshipDataKind, { at: Date; dated: SponsorshipFactSource['dated'] } | null> = {
    [DOL_LCA_SOURCE]: lca ? { at: lca.importedAt, dated: 'imported' } : null,
    [USCIS_H1B_HUB_SOURCE]: hub ? { at: hub.asOf, dated: 'published' } : null,
    [UK_SPONSOR_REGISTER_SOURCE]: register ? { at: register.asOf, dated: 'published' } : null,
  };
  return sponsorshipDataSources().flatMap((publication) => {
    const found = newest[publication.kind];
    return found ? [{ ...publication, asOf: found.at.toISOString(), dated: found.dated }] : [];
  });
}

export function createSponsorshipService(db: SponsorshipDb, deps: SponsorshipServiceDeps = {}): SponsorshipService {
  /** The country of the job the facts are shown on: a job of this company that the viewer may see, else null. */
  async function jobCountry(market: Market, companyId: string, viewer: SponsorshipViewer): Promise<string | null> {
    if (!viewer.jobId) return null;
    const job = (await db.rAJob.findFirst({
      where: { id: viewer.jobId, market, companyId },
      select: { locationCountry: true, visibility: true, ownerUserId: true },
    })) as { locationCountry: string | null; visibility: string; ownerUserId: string | null } | null;
    if (!job || (job.visibility !== 'public' && job.ownerUserId !== viewer.userId)) return null;
    return job.locationCountry;
  }

  async function viewerNeeds(market: Market, companyId: string, viewer: SponsorshipViewer): Promise<boolean> {
    if (!viewer.userId || !deps.viewerNeed) return false;
    try {
      const [need, country] = await Promise.all([deps.viewerNeed(viewer.userId), jobCountry(market, companyId, viewer)]);
      return needsSponsorshipIn(need, country);
    } catch (err) {
      // The facts are the answer; who the block opens for is a convenience and never fails it.
      logger.warn('COMPANIES', 'sponsorship facts: the viewer\'s answers could not be read; the block stays closed', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  return {
    async facts(market, idOrSlug, viewer = { userId: null }) {
      const company = await findCompanyRow(db, market, idOrSlug);
      if (market !== 'intl' || !company.nameNormalized) return EMPTY();
      const name = company.nameNormalized;
      const [lca, hub, register] = await Promise.all([
        db.rAH1bEmployerStat.findMany({
          where: { employerNameNormalized: name },
          orderBy: { fiscalYear: 'desc' },
          take: SPONSORSHIP_YEARS_PER_SOURCE,
          select: { fiscalYear: true, certifiedCount: true, sourceFile: true, importedAt: true },
        }) as Promise<LcaRow[]>,
        // 'FY2025' sorts as its year does: four digits after a fixed prefix.
        db.rASponsorRegisterEntry.findMany({
          where: { country: USCIS_COUNTRY, employerNameNormalized: name, source: USCIS_H1B_HUB_SOURCE },
          orderBy: { period: 'desc' },
          take: SPONSORSHIP_YEARS_PER_SOURCE,
          select: REGISTER_SELECT,
        }) as Promise<RegisterRow[]>,
        db.rASponsorRegisterEntry.findFirst({
          where: { country: UK_SPONSOR_REGISTER_COUNTRY, employerNameNormalized: name, source: UK_SPONSOR_REGISTER_SOURCE },
          orderBy: { asOf: 'desc' },
          select: REGISTER_SELECT,
        }) as Promise<RegisterRow | null>,
      ]);
      const facts: SponsorshipFact[] = [
        ...lca.map(toDolLcaFact),
        ...hub.map(toUscisFact).filter((f): f is UscisH1bHubFact => f !== null),
        ...(register ? [toUkRegisterFact(register)] : []),
      ];
      if (!facts.length) return EMPTY();
      return { facts, disclaimer: SPONSORSHIP_DISCLAIMER, viewerNeedsSponsorship: await viewerNeeds(market, company.id, viewer) };
    },
  };
}
