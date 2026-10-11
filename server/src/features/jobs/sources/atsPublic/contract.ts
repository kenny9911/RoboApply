// server/src/features/jobs/sources/atsPublic/contract.ts
//
// Public ATS job-board sources (TASK_PLAN.md WP-42; TW-02; MARKET_STRATEGY
// JI-3, JI-4, JI-8, JC-4, JC-8, JT-5): `RACareerSiteSource` rows read through
// the boards' public posting APIs (Greenhouse `boards-api…/jobs?content=true`,
// Lever `?mode=json` on both of its instances, Ashby posting API,
// SmartRecruiters postings, the Workable widget listing, Recruitee's Careers
// Site API, Personio's XML feed; 北森 tenant boards only behind
// CN_ATS_BEISEN_ENABLED). No Workday scraping. Admin mount:
// /api/v1/roboapply/admin/career-sources.
//
// One board, both brands. A board is one row ((ats, boardToken) is unique) and
// is read once; each posting lands in the market of its own location
// (mainland China -> cn, anything else -> intl). `countries` says which
// countries the board is read for: an empty list means every country the
// brands serve. `market` on a row only records the console that added it; it
// decides nothing. In a list request `market` means "boards that feed this
// market": cn = `countries` is empty or contains CN; intl = `countries` is
// empty or contains any code other than CN.
//
// A source's `origin` says how it came to be: 'admin' (added in the console),
// 'seed' (the validated seed files), 'import' (a bulk import) or 'discovered'
// (named by the apply link of an ingested or imported posting). A discovered
// or imported board that is not switched on yet is a candidate: the board
// sync reads its listing once and switches it on only when the board answers
// and its company matches.

import { z } from 'zod';

/**
 * Every job-board system a connector reads. Also the `RAJob.sourceBoard` of the
 * rows it writes, so the consumers that ask "is this an employer-board row?"
 * (the feed's source line, the daily maintenance, the public-display scope)
 * read this one list. `lever_eu` is Lever's EU instance: another host and
 * another id namespace, so its rows keep their own board name. `beisen` is in
 * the list so that its rows are recognised, but its connector exists only
 * while CN_ATS_BEISEN_ENABLED is true (./connectors.ts `connectorEnabled`):
 * with the flag off a source cannot be added, no request can be built and an
 * existing source is skipped.
 */
export const PUBLIC_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio', 'lever_eu', 'beisen'] as const;
/** A job-board system: any entry of PUBLIC_ATS. */
export type BoardAts = (typeof PUBLIC_ATS)[number];
/**
 * The four systems read since WP-42. KEPT NARROW ON PURPOSE (MKT-5B):
 * components/v3/admin/SourcesConsole.tsx keys a `Record` by this type and
 * indexes it with `CareerSourceView.ats`, and that file has no owner in M5, so
 * widening the type would break the web type-check there. Server code uses
 * `BoardAts`. Once that console reads its list from the contract mirror
 * (handoff MKT-5B, Requests), this alias becomes `BoardAts` and goes.
 */
export type PublicAts = Extract<BoardAts, 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters'>;

/** A board id as the job-board system writes it in its URLs. */
export const BOARD_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;

/**
 * Systems whose board lives on a host of the tenant's own (`<label>.recruitee.com`,
 * `<label>.jobs.personio.de`, `<label>.zhiye.com`): the board id is that
 * sub-domain label, so it goes into a HOST name and is held to a DNS label in
 * lower case (./http.ts refuses every other host before a request is sent).
 */
export const TENANT_HOST_ATS = ['recruitee', 'personio', 'beisen'] as const;
/** One DNS label, lower case: letters, digits and inner hyphens, at most 63 characters. */
export const TENANT_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Appended to a Personio board id whose career site is on jobs.personio.com (the default host is jobs.personio.de). */
export const PERSONIO_COM_SUFFIX = '.com';
/** Labels that are a vendor's own site, never a tenant. */
export const RESERVED_TENANT_LABELS: readonly string[] = ['www', 'api', 'app', 'docs', 'support', 'help', 'status', 'careers', 'jobs'];

/** The tenant label of a board id of a tenant-host system (Personio: without the `.com` marker), or null when the id is not one. */
export function tenantLabelOf(ats: string, boardToken: string): string | null {
  if (!(TENANT_HOST_ATS as readonly string[]).includes(ats)) return null;
  const label = ats === 'personio' && boardToken.endsWith(PERSONIO_COM_SUFFIX) ? boardToken.slice(0, -PERSONIO_COM_SUFFIX.length) : boardToken;
  return TENANT_LABEL_PATTERN.test(label) && !RESERVED_TENANT_LABELS.includes(label) ? label : null;
}

/**
 * Is `boardToken` a board id this system can have? Every system: the general
 * pattern. A tenant-host system: the lower-case sub-domain label (Personio:
 * `<label>` or `<label>.com`), because the id becomes part of a host name.
 */
export function isBoardTokenFor(ats: string, boardToken: unknown): boardToken is string {
  if (typeof boardToken !== 'string' || !BOARD_TOKEN_PATTERN.test(boardToken)) return false;
  return (TENANT_HOST_ATS as readonly string[]).includes(ats) ? tenantLabelOf(ats, boardToken) !== null : true;
}

/** ISO 3166-1 alpha-2, upper case. */
const CountryCode = z.string().regex(/^[A-Z]{2}$/);
/** The countries a board is read for (at most 60); empty = every country the brands serve. */
export const CareerSourceCountriesSchema = z.array(CountryCode).max(60);

export const CAREER_SOURCE_ORIGINS = ['admin', 'seed', 'import', 'discovered'] as const;
export type CareerSourceOrigin = (typeof CAREER_SOURCE_ORIGINS)[number];

/**
 * 'enabled'    the board sync reads it;
 * 'candidate'  discovered or imported, not switched on yet (waiting for its first list-only read, or that read did not match);
 * 'disabled'   switched off by an admin, or by three failed reads in a row (`disabledAt` is set then).
 */
export const CAREER_SOURCE_STATES = ['enabled', 'candidate', 'disabled'] as const;
export type CareerSourceState = (typeof CAREER_SOURCE_STATES)[number];

export const CareerSourceBodySchema = z
  .object({
    /** Ignored: a board is not tied to one market. Kept so earlier clients still validate. */
    market: z.enum(['intl', 'cn']).optional(),
    ats: z.enum(PUBLIC_ATS),
    boardToken: z.string().trim().regex(BOARD_TOKEN_PATTERN),
    companyName: z.string().trim().min(1).max(200),
    companyId: z.string().min(1).max(64).optional(),
    /** A weak hint for an ambiguous city. Never a filter (that is `countries`). */
    countryCode: CountryCode.optional(),
    countries: CareerSourceCountriesSchema.default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  // The id of a tenant-host board becomes a host name: lower-case sub-domain label only.
  .refine((b) => isBoardTokenFor(b.ats, b.boardToken), { message: 'invalid_board_id', path: ['boardToken'] });
export const PatchCareerSourceBodySchema = z
  .object({
    companyName: z.string().trim().min(1).max(200).optional(),
    companyId: z.string().min(1).max(64).nullable().optional(),
    countryCode: CountryCode.nullable().optional(),
    countries: CareerSourceCountriesSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const CareerSourceParamsSchema = z.object({ id: z.string().min(1).max(64) });
export const ListCareerSourcesQuerySchema = z.object({
  /** Boards that feed this market (see the header). Default: the market of the brand the admin is on. */
  market: z.enum(['intl', 'cn']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
  origin: z.enum(CAREER_SOURCE_ORIGINS).optional(),
  state: z.enum(CAREER_SOURCE_STATES).optional(),
});

export interface CareerSourceView {
  id: string;
  /** The console that added the board. Display only. */
  market: 'intl' | 'cn';
  /**
   * The board's system. Sent as stored: ANY entry of PUBLIC_ATS (`BoardAts`).
   * The static type is still the four systems of WP-42 only because of the
   * console named at `PublicAts`; a reader must not assume the value is one of
   * the four (both consoles already fall back to the raw id).
   */
  ats: PublicAts;
  boardToken: string;
  companyName: string;
  companyId: string | null;
  countryCode: string | null;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastJobCount: number | null;
  lastError: string | null;
  // The fields below are always sent since the market wave (MKT-3D). They are optional in the type so
  // that a client or fixture written against the earlier view still type-checks; a reader uses a safe
  // default (origin 'admin', no countries, state from `enabled`).
  origin?: CareerSourceOrigin;
  /** For a discovered board: '<sourceBoard>:<externalId>' of the posting that named it, or 'user_import'. */
  discoveredFrom?: string | null;
  /** ISO codes the board is read for; empty = every country the brands serve. */
  countries?: string[];
  /** Failed reads in a row that count toward switching the board off (three do). */
  failCount?: number;
  /** When a read last added or closed a posting. */
  lastChangeAt?: string | null;
  /** When the board is next read; null = at the next board sync. */
  nextSyncAt?: string | null;
  /** Set when the board was switched off, by three failed reads or by an admin. */
  disabledAt?: string | null;
  state?: CareerSourceState;
}

/**
 * The answer of `GET /`. `systems`: the job-board systems whose connector is
 * switched on in this deployment, in the order of PUBLIC_ATS. A console offers
 * only those when adding a board; a client that predates the field (or a
 * server that does not send it) offers every system and is told
 * 'connector_disabled' when one of them cannot be added.
 */
export interface CareerSourceListResult {
  items: CareerSourceView[];
  cursor: null;
  systems?: BoardAts[];
}

// -- Bulk import (JI-3) ---------------------------------------------------

export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_CSV_CHARS = 1_000_000;
export const IMPORT_MAX_INVALID_REPORTED = 100;
/** The CSV header, in this order; `countries` holds codes separated by '|'. */
export const IMPORT_CSV_COLUMNS = ['ats', 'boardToken', 'companyName', 'countries'] as const;

/**
 * One row as sent: `{ ats, boardToken, companyName?, countries? }`. The schema
 * accepts ANY value here on purpose: each row is checked by the service
 * (service.ts `checkImportRow`), so a row with a missing or wrongly typed
 * field is reported by its number and reason ('unreadable_row',
 * 'unknown_job_board', 'invalid_board_id', …) and never refuses the whole
 * file. The size of the file is bounded by the row limit and the request body
 * limit.
 */
const ImportRowSchema = z.unknown();
/** The shape of a row a client should send (the web wrapper's type; not enforced, see ImportRowSchema). */
export interface ImportCareerSourceRow {
  ats: string;
  boardToken: string;
  companyName?: string | null;
  countries?: string[] | null;
}

export const ImportCareerSourcesBodySchema = z
  .object({
    format: z.enum(['json', 'csv']),
    rows: z.array(ImportRowSchema).max(IMPORT_MAX_ROWS).optional(),
    csv: z.string().max(IMPORT_MAX_CSV_CHARS).optional(),
    /** false (the default): the rows are candidates, switched on by the board sync after a matching list-only read. */
    enable: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.format === 'json' ? Array.isArray(b.rows) && b.csv === undefined : typeof b.csv === 'string' && b.rows === undefined), {
    message: 'send rows with format json, or csv with format csv',
    path: ['format'],
  });

/** `connector_disabled`: the row names a system whose connector is switched off on this deployment (./connectors.ts `connectorEnabled`). */
export type ImportInvalidReason =
  | 'unknown_job_board'
  | 'invalid_board_id'
  | 'invalid_country'
  | 'too_many_countries'
  | 'company_name_too_long'
  | 'duplicate_in_file'
  | 'unreadable_row'
  | 'connector_disabled';

export interface ImportCareerSourcesResult {
  /** Rows in the file. */
  total: number;
  /** New boards added. */
  created: number;
  /** Boards that were already in the list (their countries were merged; nothing else changed). */
  merged: number;
  /** The first IMPORT_MAX_INVALID_REPORTED rejected rows: 1-based row number (the CSV header is line 1) and why. */
  invalid: Array<{ line: number; reason: ImportInvalidReason }>;
  /** Every rejected row, including those not listed in `invalid`. */
  invalidCount: number;
}

/** Display names of the public job-board systems (vendor names are data, never bundle copy). Both Lever instances read "Lever". */
export const PUBLIC_ATS_NAMES: Readonly<Record<BoardAts, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  recruitee: 'Recruitee',
  personio: 'Personio',
  lever_eu: 'Lever',
  beisen: '北森',
};

/** `error` of a read, `details.reason` of a refused create and the reason of a refused import row, when the system's connector is switched off. */
export const CONNECTOR_DISABLED = 'connector_disabled';

/**
 * `POST /:id/run` ("Check now"): the board's listing is read once to report
 * what it lists (or why it cannot be read); when it can, the source is marked
 * due and the next board sync (every 5 minutes) reads and saves its postings.
 */
export interface CareerSourceRunResult {
  sourceId: string;
  /** 'scheduled': the board was read and is due at the next board sync; 'error': it could not be read. */
  status: 'scheduled' | 'error';
  /** Postings the board lists right now. */
  listed: number;
  /** True when the board was marked due: the next board sync reads it. */
  queued: boolean;
  error: string | null;
}

// ── Taiwan card meta (marketHooks.cardMeta → `meta.ats_public`) ──────────

/** Work-authorization tags for Taiwan, each shown only with a quote from the posting (TW-09). */
export const TW_PERMIT_TAGS = ['tw_work_permit_support', 'tw_gold_card'] as const;
export type TwPermitTag = (typeof TW_PERMIT_TAGS)[number];

export interface TwPermitTagView {
  tag: TwPermitTag;
  /** Verbatim sentence from the posting (≤ 240 characters). */
  quote: string;
}

/**
 * `cardMeta(job).ats_public` for jobs in Taiwan (JobMetaTw). Pay is only ever
 * the posting's own text: `negotiable` means the posting says 面議 / 依公司規定
 * and gives no figure; nothing here estimates or implies an amount (TW-03).
 */
export interface TwCardMeta {
  country: 'TW';
  pay: {
    /**
     * The pay text for cards: as posted, except that for a 面議 posting the
     * Employment Services Act Art. 5 floor clause ("經常性薪資達4萬元或以上")
     * is removed, because it is the legal rule, not this job's pay. Null when
     * the posting gives no pay text.
     */
    text: string | null;
    /** The pay text exactly as posted (shown on the job page as the posting's own words), or null. */
    posted: string | null;
    /** The posting states an amount or range. */
    disclosed: boolean;
    /** The posting says pay is negotiable / per company rules, with no figure. */
    negotiable: boolean;
  };
  permitTags: TwPermitTagView[];
  source: {
    /** e.g. "Appier · Greenhouse" (company + job board). */
    name: string | null;
    url: string | null;
    board: BoardAts | null;
  };
}
