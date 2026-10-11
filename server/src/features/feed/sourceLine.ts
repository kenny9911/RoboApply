// server/src/features/feed/sourceLine.ts — where a posting comes from, where
// its apply link leads, and its pay as posted (GOAPPLY_PARITY_PLAN §3.9 and the
// §5 contract; MARKET_STRATEGY §1.4 display rules, M-7, JC-1; D1, D3).
//
// One rule for every reader that shows a job (feed card, similar job, job
// page, visitor list), so the card and the page can never disagree:
//
//   apply   { url, target }   the posting's own apply link, opened by the user
//                             (D1: nothing here submits or pre-submits).
//                             target 'gohire'   = the GoHire posting page (a
//                                                 GoHire bank row; such a row is
//                                                 listed only when GoHire has a
//                                                 public job page, ingest rule);
//                             target 'employer' = the employer's own careers
//                                                 site or its ATS page (a row
//                                                 read from a public employer
//                                                 board);
//                             target null       = a link the user added
//                                                 themselves, or another
//                                                 source's link: where it leads
//                                                 is not known, so nothing is
//                                                 claimed (D3).
//                             The whole value is null when the row has no
//                             usable http(s) apply link.
//   source  { original, url, lastVerifiedAt, via }
//                             original        the original publisher: the
//                                             employer for a board row, the
//                                             stored original publisher for a
//                                             repost, null when not known;
//                             url             the original posting link
//                                             (never a LinkedIn URL);
//                             lastVerifiedAt  when we last saw the posting live
//                                             at its source (RAJob.lastSeenAt):
//                                             "最后核验 {date}" / "Last checked";
//                             via             'bank' | 'ats' | 'import'; absent
//                                             for an aggregator row (RoboApply's
//                                             search providers), which is none
//                                             of the three.
//   salary  { text, min, max, currency, period, months } | null
//                             pay as the posting states it; null when the
//                             posting states no pay ("薪资未披露" / "Pay not
//                             listed"; never 面议, never 0, never an estimate).
//
// The feed header facts (`sources`) and the "thin result" rule live in
// FeedQueryService / sql.ts (`sourcesSql`); they use `EMPLOYER_BOARD_SOURCES`
// and `GOHIRE_SOURCE_BOARD` from here so the card and the header count the
// same rows.

import { PUBLIC_ATS } from '../jobs/sources/atsPublic/contract.js';
import { bankPublicJobUrlTemplate } from '../../roboapply/v2/lib/raCrossBankMatch.js';

export type SourceKind = 'provider' | 'bank' | 'ats_public' | 'user_import';
export type SourceVia = 'bank' | 'ats' | 'import';
export type ApplyTarget = 'gohire' | 'employer';

export interface ApplyLink {
  url: string;
  /** Null: where the link leads is not known (a user's own import, an aggregator's link). */
  target: ApplyTarget | null;
}

export interface SourceFacts {
  /** The original publisher (the employer for a board row); null when not known. */
  original: string | null;
  /** The original posting link (http/https, never LinkedIn); null when the row has none. */
  url: string | null;
  /** ISO time we last saw the posting live at its source (RAJob.lastSeenAt). */
  lastVerifiedAt: string | null;
  /** How the posting reached us. Absent for an aggregator row. */
  via?: SourceVia;
}

export type PayPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';

export interface SalaryLine {
  /** The pay line as posted ("18-28K·15薪"); null when only the figures below are known. */
  text: string | null;
  min: number | null;
  max: number | null;
  currency: string | null;
  period: PayPeriod | null;
  /** CN "N薪" when the posting states it. */
  months: number | null;
}

/** `RAJob.sourceBoard` of a GoHire recruiter-bank row. */
export const GOHIRE_SOURCE_BOARD = 'gohire';

/** `RAJob.sourceBoard` of each recruiter bank's rows (the bank's id). */
export const RECRUITER_BANK_BOARDS = ['robohire', GOHIRE_SOURCE_BOARD] as const;

type EnvLike = Record<string, string | undefined>;

/**
 * The recruiter banks that have no candidate-facing posting page right now
 * (`GOHIRE_PUBLIC_JOB_URL_TEMPLATE` / `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` unset
 * or unusable). "A recruiter-bank row needs a real posting page"
 * (GOAPPLY_PARITY_PLAN §3.9): the link such a row stores is the bank site's
 * "Page not found", so the row is held, never listed. The bank sync archives
 * these rows ('no_apply_target'), and since MKT-3C the daily maintenance does
 * too, whatever the sync's state (ingest/maintain.ts `archiveDeadBankLinks`).
 * This hold stays as the read-side safety net between those runs: for a row
 * stored by another writer, or one maintenance has not reached yet.
 * Both markets.
 */
export function heldBankBoards(env: EnvLike = process.env): string[] {
  return RECRUITER_BANK_BOARDS.filter((bank) => bankPublicJobUrlTemplate(bank, env) === null);
}

/** False for a recruiter-bank row whose bank has no posting page (see `heldBankBoards`). */
export function bankListable(row: { fromRecruiterBank?: unknown; sourceBoard?: unknown }, env: EnvLike = process.env): boolean {
  if (row.fromRecruiterBank !== true || typeof row.sourceBoard !== 'string') return true;
  return !heldBankBoards(env).includes(row.sourceBoard);
}

/**
 * `bankListable` as a Prisma `where` fragment (AND it in), or null when every
 * bank has a posting page. The raw-SQL twin is `scopePredicates` in
 * feed/sql.ts (`SqlScope.heldBanks`).
 */
export function bankListableWhere(env: EnvLike = process.env): { NOT: { fromRecruiterBank: true; sourceBoard: { in: string[] } } } | null {
  const held = heldBankBoards(env);
  return held.length ? { NOT: { fromRecruiterBank: true, sourceBoard: { in: held } } } : null;
}

/**
 * `RAJob.sourceBoard` of the sources whose licence asks for a credit line
 * wherever one of their rows is shown: the Taiwan open-data datasets (OGDL
 * v1: 台灣就業通's vacancy list and 事求人; "Attribution on every open-data
 * row (the licence voids itself without it)", MARKET_STRATEGY §1.3). The
 * sentence itself is server data (jobs/sources/twHooks.ts
 * `TW_OPEN_DATA_ATTRIBUTIONS`, the same keys: a test holds the two together).
 */
export const CREDIT_LINE_BOARDS: readonly string[] = ['tw_open_data', 'tw_gov_jobs'];

/**
 * True for a row that owes a credit line. A surface that prints the line
 * shows the row (the feed card and the job page: `cardMeta.tw_sources`
 * through `JobMetaTw`). A surface that CANNOT print it yet holds the row out
 * with this predicate, so no open-data row is shown uncredited:
 *   - job alerts, in the app and by e-mail (alerts/repo.ts, alerts/service.ts);
 *   - similar jobs (jobs/detail/service.ts `similarScope`);
 *   - the Assistant's job lists (copilot/tools/jobs.ts) and the Ready to
 *     apply suggestions and picks (agent/deps.ts), through `itemOwesCreditLine`.
 * Remove a use when its surface carries the line: the Assistant cards with
 * MKT-4H.1, similar jobs with MKT-5C.3, alerts and Ready to apply with
 * Orchestrator 3 (requests/waveM3-carryover.md). Tracker rows are the
 * person's own saved jobs and are not held (Orchestrator 3 there).
 */
export function creditLineHeld(row: { sourceBoard?: unknown }): boolean {
  return typeof row.sourceBoard === 'string' && CREDIT_LINE_BOARDS.includes(row.sourceBoard);
}

/**
 * `creditLineHeld` for a feed item, which carries no `sourceBoard`: the feed
 * attaches the sentence the row owes as `cardMeta.tw_sources.attribution`
 * (jobs/sources/twHooks.ts). For the readers that take their rows from
 * `feedService.preview` (the Assistant's job lists, the Ready to apply picks).
 */
export function itemOwesCreditLine(item: { cardMeta?: unknown }): boolean {
  const meta = item.cardMeta;
  if (!meta || typeof meta !== 'object') return false;
  const tw = (meta as Record<string, unknown>).tw_sources;
  return !!tw && typeof tw === 'object' && !!(tw as { attribution?: unknown }).attribution;
}

/** `creditLineHeld` as a Prisma `where` fragment (AND it in). The raw-SQL twin is `SqlScope.heldBoards` (feed/sql.ts). */
export function creditLineHeldWhere(): { NOT: { sourceBoard: { in: string[] } } } {
  return { NOT: { sourceBoard: { in: [...CREDIT_LINE_BOARDS] } } };
}

/**
 * `RAJob.sourceBoard` values the lists' posting-age floor never applies to:
 * the recruiter banks and the public ATS boards. "No posting-age cut-off for
 * board or bank rows" (GOAPPLY_PARITY_PLAN §3.9, MARKET_STRATEGY M-22): an
 * employer lists a role for as long as it is open, often for months, and the
 * source's own sync closes it. The same list as the ingest side's
 * `NO_DATE_EXPIRY_BOARDS` (jobs/ingest/maintain.ts; a test holds them equal).
 */
export const NO_AGE_FLOOR_BOARDS: readonly string[] = [...new Set<string>([...RECRUITER_BANK_BOARDS, ...PUBLIC_ATS])];

/**
 * `RAJob.sourceBoard` values of rows read from a public employer board (the
 * documented job-board APIs of jobs/sources/atsPublic, where `sourceBoard` is
 * the ATS name, plus the two older spellings the feed card has always read as
 * a board). The feed header counts employer boards among exactly these rows.
 */
export const EMPLOYER_BOARD_SOURCES: readonly string[] = [...new Set<string>([...PUBLIC_ATS, 'workable', 'ats_public'])];
const EMPLOYER_BOARD_SET: ReadonlySet<string> = new Set(EMPLOYER_BOARD_SOURCES);

/**
 * How a row reached us, from its own columns: the user's import (or any
 * private row), a recruiter bank, a public employer board, else an aggregator.
 * A board is claimed only for a known board source: an unknown `sourceBoard`
 * is never called an employer board (D3).
 */
export function sourceKindOf(row: { sourceBoard: string; visibility?: string | null; fromRecruiterBank: boolean }): SourceKind {
  if (row.sourceBoard === 'user_import' || row.visibility === 'private') return 'user_import';
  if (row.fromRecruiterBank) return 'bank';
  if (EMPLOYER_BOARD_SET.has(row.sourceBoard)) return 'ats_public';
  return 'provider';
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** An http(s) URL as stored, or null (javascript:, mailto:, relative paths and junk never leave the server as a link). */
export function httpUrl(v: unknown): string | null {
  const raw = text(v);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

/** True when the row has a usable apply link (the rule "a posting with no usable apply URL is never listed"). */
export function hasApplyLink(row: { applyUrl?: unknown }): boolean {
  return httpUrl(row.applyUrl) !== null;
}

/**
 * "A posting with no usable apply URL is never listed" for mainland postings
 * (MARKET_STRATEGY JC-7; D1, D3): a PUBLIC `market = 'cn'` row is listed (feed,
 * similar jobs, alerts, Ready to apply) only with a usable apply link. The
 * ingest pipeline already refuses to store such a row; this is the read-side
 * guard for rows written before that rule or by another writer. A user's own
 * import (private) is theirs with or without a link, and other markets keep
 * their own rule unchanged.
 */
export function cnListable(row: { market?: unknown; visibility?: unknown; applyUrl?: unknown }): boolean {
  if (row.market !== 'cn' || row.visibility !== 'public') return true;
  return hasApplyLink(row);
}

/**
 * `cnListable` as a Prisma `where` fragment for list queries over `market =
 * 'cn'` rows (AND it in). The raw-SQL twin is `scopePredicates` in feed/sql.ts.
 */
export function cnListableWhere(): { OR: Array<Record<string, unknown>> } {
  return {
    OR: [
      { visibility: { not: 'public' } },
      { applyUrl: { startsWith: 'http://', mode: 'insensitive' } },
      { applyUrl: { startsWith: 'https://', mode: 'insensitive' } },
    ],
  };
}

function isLinkedIn(url: string): boolean {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isoOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** `via` of a source kind; an aggregator (`provider`) is none of the three. */
export function viaOf(kind: SourceKind): SourceVia | undefined {
  if (kind === 'bank') return 'bank';
  if (kind === 'ats_public') return 'ats';
  if (kind === 'user_import') return 'import';
  return undefined;
}

export interface SourceRowLike {
  sourceBoard: string;
  companyName: string;
  companyDisplayName?: string | null;
  originalSourceName?: string | null;
  sourceUrl?: string | null;
  applyUrl?: string | null;
  lastSeenAt?: Date | string | null;
}

/**
 * The apply link of a row (see the header). Never fabricated: no link → null.
 * A recruiter-bank row whose bank has no posting page has no link either: the
 * one it stores opens the bank site's "Page not found" (`heldBankBoards`).
 */
export function applyLinkOf(row: Pick<SourceRowLike, 'applyUrl' | 'sourceBoard'>, kind: SourceKind, env: EnvLike = process.env): ApplyLink | null {
  const url = httpUrl(row.applyUrl);
  if (!url) return null;
  if (kind === 'bank' && heldBankBoards(env).includes(row.sourceBoard)) return null;
  if (kind === 'bank') return { url, target: row.sourceBoard === GOHIRE_SOURCE_BOARD ? 'gohire' : null };
  if (kind === 'ats_public') return { url, target: 'employer' };
  return { url, target: null };
}

/** Original publisher, original link, last-verified time and `via` of a row (see the header). */
export function sourceFactsOf(row: SourceRowLike, kind: SourceKind): SourceFacts {
  const via = viaOf(kind);
  const employer = text(row.companyDisplayName) ?? text(row.companyName);
  // A board row is the employer's own posting; everywhere else only a stored original publisher counts.
  const original = kind === 'ats_public' ? (employer ?? text(row.originalSourceName)) : text(row.originalSourceName);
  const link = httpUrl(row.sourceUrl) ?? httpUrl(row.applyUrl);
  return {
    original,
    url: link && !isLinkedIn(link) ? link : null,
    lastVerifiedAt: isoOf(row.lastSeenAt),
    ...(via ? { via } : {}),
  };
}

const PERIODS: ReadonlySet<string> = new Set(['year', 'month', 'week', 'day', 'hour']);

/**
 * Does this stated pay carry a figure above zero? Some sources send 0 where
 * they have nothing; 0 is never pay.
 */
export function hasPayFigure(pay: { min: number | null; max: number | null } | null): boolean {
  return !!pay && ((pay.min ?? 0) > 0 || (pay.max ?? 0) > 0);
}

/**
 * The contract's `salary` from the reader's own stated-pay answer (`pay`: the
 * figures it shows, already checked for disclosure and plausibility) and the
 * pay line in words (`line`: the posting's own text when it states an amount,
 * or the mainland notation built from the figures). Null when neither exists.
 */
export function salaryLineOf(
  pay: { min: number | null; max: number | null; currency: string | null; period: string | null; text?: string | null } | null,
  line: string | null,
  months: number | null = null,
): SalaryLine | null {
  const words = text(line) ?? text(pay?.text);
  if (!pay && !words) return null;
  return {
    text: words,
    min: pay?.min ?? null,
    max: pay?.max ?? null,
    currency: pay ? text(pay.currency) : null,
    period: pay?.period && PERIODS.has(pay.period) ? (pay.period as PayPeriod) : null,
    months: typeof months === 'number' && Number.isFinite(months) && months > 0 ? months : null,
  };
}
