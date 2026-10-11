// server/src/features/jobs/sources/atsPublic/connectors/common.ts — what every
// job-board connector shares (WP-42; MKT-5B): the connector interface, the
// shape of one board read, and the small mapping helpers. ../connectors.ts
// holds the connectors of the four systems read since WP-42 and the registry;
// the systems added by MKT-5B have a file each in this directory.

import { resolveCountry } from '../../../geo/index.js';
import type { ProviderJobInput } from '../../../normalize/index.js';
import type { BoardAts } from '../contract.js';
import type { HttpDeps } from '../http.js';
import { atsSourceName, externalIdFor, num, str } from '../shared.js';

/** What a connector needs to know about one career source. */
export interface BoardSource {
  ats: BoardAts;
  boardToken: string;
  companyName: string;
  /** Ops tag: the country the board mainly hires in (weak hint only, never a filter). */
  countryCode: string | null;
  /** ISO codes the board is read for; empty or absent = every country. */
  countries?: readonly string[] | null;
}

export interface BoardRead {
  /** Postings whose text was read this run, in the normalizer's input shape (not yet routed to a market). */
  inputs: ProviderJobInput[];
  /** EVERY posting the board lists, mapped from the listing alone (enough to place it; no text for SmartRecruiters). */
  listing: ProviderJobInput[];
  /** externalIds of `listing`. */
  listedIds: string[];
  /** How many postings the board lists: `listing.length`, or the board's own total when only the first page was read. */
  listedCount: number;
  /** False when the listing was cut short (a paging safety stop, a per-run cap): closures are then skipped. */
  complete: boolean;
  /** HTTP requests made. */
  calls: number;
  /** Listed postings we have not stored yet whose text this run did not ask for (the per-run budget was used up, or the run ran out of time). */
  pendingDetails: number;
  /** Listed postings we have not stored yet whose text this run asked for and could not read. */
  failedDetails: number;
  /** The company name the board itself states, when it states one and was asked or already carries it. */
  boardCompanyName: string | null;
  /** Postings the connector left out by its own rule (a 北森 posting outside mainland China). Counted, never written. */
  droppedPostings?: number;
  /**
   * True when the connector asked the board only WHICH postings it lists and
   * found nothing to read: no posting we do not hold, none edited since our
   * copy (Greenhouse's listing without texts). `inputs` is then empty, and
   * `listing` / `listedIds` name the listed postings by their plain
   * externalId and nothing more: that listing does not say where a posting is
   * (it carries no offices), so it MUST NEVER BE ROUTED to a market. The
   * caller compares by posting id instead (../sync.ts): a stored row whose
   * posting is listed is marked as seen ("Last checked" moves on, nothing is
   * rewritten), one whose posting is not listed is closed. Absent: an
   * ordinary read, routed as usual.
   */
  unchangedById?: boolean;
}

export interface ConnectorDeps extends HttpDeps {
  now: Date;
}

export interface ReadOptions {
  /** Read the listing only: no posting texts, no inputs. */
  listOnly?: boolean;
  /**
   * With `listOnly`: one request per country pass where the listing is paged
   * without its texts (SmartRecruiters), and one page where it is paged with
   * them (北森). `listedCount` is then the board's own total and the read is
   * `complete` only when that page was the whole listing.
   */
  firstPage?: boolean;
  /**
   * Our open rows of this board: externalId -> when ingest last saved the
   * posting or marked it as seen (RAJob.lastSeenAt). Decides which posting
   * texts SmartRecruiters reads, and whether Greenhouse needs its texts at all.
   */
  known?: ReadonlyMap<string, Date | null>;
  /**
   * The externalIds a listed posting is stored under by this deployment
   * (../market.ts `storedIdsOf`). Empty = the posting is not written here, so
   * its text is never requested. Default: the posting's own externalId.
   */
  storedIds?: (listed: ProviderJobInput) => string[];
  /**
   * This deployment keeps EVERY posting of the board, wherever it is: the
   * source is read for every country and both markets are written here
   * (../sync.ts `readBoard`). Only then does "listed, and we hold no row of
   * it" mean "new", so only then is a listing compared with our rows by
   * posting id alone (Greenhouse's first step). Default false: the board is
   * read whole.
   */
  storesEveryPosting?: boolean;
  /** SmartRecruiters posting texts read this run (default SR_MAX_DETAILS). */
  detailsBudget?: number;
  /** Also report the company name the board states (see ../connectors.ts). */
  boardCompany?: boolean;
}

/** A source registered without a company name carries its board id as the name until the board's own name is read. */
export function hasPlaceholderName(source: Pick<BoardSource, 'companyName' | 'boardToken'>): boolean {
  return source.companyName.trim() === source.boardToken;
}

/** The source as the postings are mapped: with the board's stated name in place of a placeholder. */
export function named(source: BoardSource, stated: string | null): BoardSource {
  return stated && hasPlaceholderName(source) ? { ...source, companyName: stated } : source;
}

export interface AtsConnector {
  ats: BoardAts;
  /** The listing URL (shown to ops in the admin panel; the address the first request is built from). */
  boardUrl(boardToken: string): string;
  read(source: BoardSource, deps: ConnectorDeps, opts?: ReadOptions): Promise<BoardRead>;
}

export const byExternalId = (i: ProviderJobInput): string => i.externalId;

export const enc = encodeURIComponent;

/** The identity fields every posting of a board carries. */
export function base(source: BoardSource, postingId: string | number, now: Date): Pick<
  ProviderJobInput,
  'externalId' | 'sourceBoard' | 'company' | 'sourcePublisher' | 'applyIsDirect' | 'fetchedAt'
> {
  return {
    externalId: externalIdFor(source.boardToken, postingId),
    sourceBoard: source.ats,
    company: source.companyName,
    sourcePublisher: atsSourceName(source.companyName, source.ats),
    applyIsDirect: true,
    fetchedAt: now.toISOString(),
  };
}

/** ISO alpha-2 from a code or a country name ("tw", "Taiwan", "臺灣"), else null. */
export function isoCountry(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  return resolveCountry(s)?.code ?? null;
}

/** The posting's own country when it states one, else the board tag as a weak (estimated) hint. */
export function countryFields(stated: string | null, source: BoardSource): Pick<ProviderJobInput, 'locationCountry' | 'locationCountryEstimated'> {
  if (stated) return { locationCountry: stated, locationCountryEstimated: false };
  if (source.countryCode) return { locationCountry: source.countryCode, locationCountryEstimated: true };
  return {};
}

export function dateFromMs(v: unknown): string | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = str(v);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** A one-answer listing as a board read: every listed posting is handed on (or none, for a list-only read). */
export function wholeBoard(listing: ProviderJobInput[], opts: ReadOptions, calls: number, boardCompanyName: string | null): BoardRead {
  return { inputs: opts.listOnly ? [] : listing, listing, listedIds: listing.map(byExternalId), listedCount: listing.length, complete: true, calls, pendingDetails: 0, failedDetails: 0, boardCompanyName };
}

/** An http(s) URL as written, or null (a link we hand on is never a script URL or a relative path). */
export function httpsUrl(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : null;
  } catch {
    return null;
  }
}
