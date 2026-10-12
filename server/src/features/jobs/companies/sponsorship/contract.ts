// server/src/features/jobs/companies/sponsorship/contract.ts
//
// Company sponsorship facts (MARKET_STRATEGY JI-11; MARKET_TASK_PLAN §3.2).
// Route: GET /api/v1/roboapply/companies/:id/sponsorship (RoboApply only, flag
// `h1bHistory`; GoApply answers 404 feature_disabled: none of these registers
// concerns the mainland). Re-exported by ../contract.ts, so the web reads these
// types through lib/api/contracts/jobs/companies.
//
// What a fact is, and is not (D3):
//   - a PUBLIC RECORD ABOUT THE EMPLOYER, with the year or the register it
//     comes from, the publication's name and page, the file we read and its
//     date. No number is shown without all of them;
//   - found by an exact match of the company's normalised name against the
//     record's normalised employer name. Nothing is matched loosely and
//     nothing is inferred: a company with no row has an empty list, which
//     says nothing about the employer either way;
//   - NEVER a statement about a job. A job is labelled as sponsoring only by
//     its own posting's words, or as a provider's reading that is labelled as
//     one (feed/items.ts). The disclaimer below says so on every answer.

import { z } from 'zod';

export const SPONSORSHIP_FACT_KINDS = ['dol_lca', 'uscis_h1b_hub', 'uk_sponsor_register'] as const;
export type SponsorshipFactKind = (typeof SPONSORSHIP_FACT_KINDS)[number];

/** Where a fact comes from. Every field is always present. */
export interface SponsorshipFactSource {
  /** "{publisher}, {publication}", e.g. "US Department of Labor, LCA disclosure data". */
  name: string;
  /** The publication's public page. */
  url: string;
  /** The file the figure was read from, by its name. */
  sourceFile: string;
  /** ISO instant; what it dates is `dated`. */
  asOf: string;
  /**
   * `published`: `asOf` is the publication date of `sourceFile` (the USCIS hub
   * and the UK register; given when the file was imported). `imported`: `asOf`
   * is the day we imported `sourceFile` (DOL LCA files: the table holds no
   * publication date; the file name carries the fiscal year and quarter).
   */
  dated: 'published' | 'imported';
  /**
   * The acknowledgement the publication's licence asks for wherever its
   * information is shown, with the licence's address (the UK register: Open
   * Government Licence v3.0). Print it with the fact. Absent when the
   * publication asks for none.
   */
  attribution?: { text: string; url: string };
}

/** H-1B labor condition applications the US Department of Labor certified for the employer in a fiscal year. */
export interface DolLcaFact {
  kind: 'dol_lca';
  fiscalYear: number;
  certifiedCount: number;
  source: SponsorshipFactSource;
}

/** H-1B petitions USCIS approved and denied for the employer in a fiscal year (first decisions; new and continuing employment). */
export interface UscisH1bHubFact {
  kind: 'uscis_h1b_hub';
  fiscalYear: number;
  approvals: number;
  denials: number;
  /** The employer's name as the record prints it (what the company's name matched). */
  employerName: string;
  source: SponsorshipFactSource;
}

/** The organisation is on the UK Register of Licensed Sponsors (Workers). */
export interface UkSponsorRegisterFact {
  kind: 'uk_sponsor_register';
  /** Null when the register lists the name in more than one town, or states none. */
  town: string | null;
  /** The register's "Type & Rating" as published, e.g. "Worker (A rating)"; several values are joined with "; ". */
  rating: string | null;
  /** The routes the organisation is licensed for, as published. */
  routes: string[];
  /** The organisation's name as the register prints it (what the company's name matched). */
  employerName: string;
  source: SponsorshipFactSource;
}

export type SponsorshipFact = DolLcaFact | UscisH1bHubFact | UkSponsorRegisterFact;

/** At most this many fiscal years per US source, the most recent first. */
export const SPONSORSHIP_YEARS_PER_SOURCE = 5;

/**
 * English source text; the web shows its own translation
 * (`companyFacts.sponsorship.disclaimer`, the same sentence in English: a web
 * test holds the two equal). Sent with every answer, also with an empty list.
 */
export const SPONSORSHIP_DISCLAIMER =
  'These are public records about the employer, not about this job. Past filings or a sponsor license do not mean this employer will sponsor this role.';

/** GET /companies/:id/sponsorship?jobId= — `jobId` is the job page the facts are shown on (optional). */
export const CompanySponsorshipQuerySchema = z.object({ jobId: z.string().min(1).max(64).optional() });

export interface CompanySponsorshipResponse {
  /**
   * DOL LCA years (newest first), then USCIS years (newest first), then the UK
   * register entry. Empty when no record carries the company's name.
   */
  facts: SponsorshipFact[];
  disclaimer: string;
  /**
   * True when the signed-in viewer's own answers say they need sponsorship in
   * the country of the job named by `jobId` (the rule the feed's sponsorship
   * badges use: the per-country work-authorisation answer, else the search
   * profile's "I need visa sponsorship"). False without a session, and when
   * there is no fact to show. The job page opens the block for these viewers
   * and keeps it behind one line for everyone else; it changes no fact.
   */
  viewerNeedsSponsorship: boolean;
}
