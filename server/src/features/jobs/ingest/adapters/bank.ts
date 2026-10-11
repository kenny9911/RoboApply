// server/src/features/jobs/ingest/adapters/bank.ts — recruiter-bank sync (WP-16b, ARCH §4.2;
// GOAPPLY_PARITY_PLAN.md §3.9, MARKET_STRATEGY JC-2 interim).
//
// One RAIngestQuery per bank (origin 'bank_sync'). A bank is read through one
// of three transports (raBankClients.bankTransport):
//
//   db           the bank's database (read-only Prisma client). Cursor
//                "<updatedAt ISO>|<Job.id>|<mark>": each step reads the recruiter
//                `Job` rows changed after it, oldest first. A row that is not
//                open AND published is closed ('bank_closed'). The mark names
//                the posting page the rows were read with ('nopage', or
//                'page:<hash of the template>'); a cursor with another mark,
//                or with none (written before the posting-page rule), restarts
//                from the beginning once, so no stored row keeps an old link.
//                The mainland bank's cursor has a fourth part, the pass start
//                ("…|<mark>|<pass start ISO>"): see "Seen again" below.
//   syndication  GoHire only, whenever GOHIRE_SYNDICATION_URL is set (it wins
//                over the two other transports; MARKET_STRATEGY §8 fix B, JC-2):
//                the same cursor over HTTPS against the syndication endpoint of
//                the GoHire backend. The wire contract, its validation and the
//                HTTP rules (TLS only, key in a header, 20 s, 5 MB, no redirect)
//                are ./syndication.ts. A page is `items` (open AND published
//                jobs) and `tombstones` (jobs that left the listing): a
//                tombstone closes its job ('bank_closed'), and the page's own
//                `nextCursor` / `hasMore` say where the sync stands. With no
//                stored cursor the endpoint is read from the beginning. A
//                request given less than its 20 s because the ingest tick was
//                ending, and that ran out of that shorter time, is a sync cut
//                short ('bank_pass_cut_short': no error, cursor kept, due at
//                once); only a request that had its full limit can time out
//                as an error.
//   api          GoHire only (the interim reader): GET <GOHIRE_API_BASE>/api/v1/jobs
//                ?status=open&sortBy=aging&limit=50&page=N. 'aging' orders
//                published rows first (publishedAt ascending, nulls last), so a
//                pass stops at the first row whose publishedAt is null and never
//                pages through unpublished requisitions. The list returns open
//                rows only, so a closed job disappears instead of arriving
//                closed: after a COMPLETE pass the adapter reports the pass's
//                listing and ingest archives the open rows missing from it
//                ('bank_closed'). A failed or cut-short pass closes nothing.
//                The cursor of this transport is its own: "api|<pass start>|<next page>".
//
// Seen again (the MAINLAND bank only, on both of its cursor transports;
// MARKET_STRATEGY §1.5 "Closure"). A change cursor returns a job only when the
// bank changed it, so a job that stays open and untouched would never be read
// again and its RAJob.lastSeenAt ("last confirmed listed") would stand still.
// The mainland closure rule (jobs-maintain, market cn only) archives a row that
// was not seen for 45 days, and that must mean "the bank stopped returning
// it", never "the bank left it alone". So the cursor sync of a bank whose rows
// are in market cn (`bankRereads`: GoHire) is read again FROM THE BEGINNING
// every INGEST_BANK_RESYNC_DAYS (default 7; the cursor carries when its pass
// began): every job the bank still lists is written again (lastSeenAt moves,
// nothing is re-enriched: the text is the same), every tombstone is applied
// again, and a row archived while it was still listed comes back. A GoHire
// cursor written before this rule has no pass start and restarts once.
// The international market has no unseen rule, so the RoboHire sync is exactly
// the parity wave's: its cursor has three parts, is never dated and is never
// read again from the beginning for its age (MARKET_STRATEGY §1.2: "unchanged").
// The list transport needs none of this: each of its passes reads the whole listing.
//
// The cross-tenant guard (RA_CROSSBANK_CROSS_TENANT_CONFIRMED) and the GoHire
// TLS rule (CN-E-05: sslmode=require, or HTTPS) live in raBankClients.
//
// What may be read (D3, privacy): the columns of BANK_SYNC_SELECT and nothing
// else (the syndication endpoint adds the bank's own employerVerified,
// syndicationConsentAt and validity). An HTTP response row is cut down to that
// whitelist in memory before anything is logged or stored, so no other field
// of the response (notes, evaluationRules, passingScore, aiInsights,
// clientKey, organizationId …) can reach a log line, an error message or a
// column. Errors carry a status code, never a response body.
//
// What is listed (the same rule for both banks and EVERY transport: the one
// gate is `classifyBankRow`, applied by `sortRows`):
//   - open AND published (`isSyncableBankJob`) with a named employer;
//   - inside its stated validity (a `validUntil` that has passed closes the row);
//   - not a recruiter's test posting;
//   - and only when the bank has a candidate-facing posting page
//     (raCrossBankMatch.bankPublicJobUrl). Neither bank has one today, so its
//     rows are synced, counted ('bank_no_public_page') and HELD: they are not
//     emitted as jobs and their ids are closed as 'no_apply_target'. They come
//     back on the first sync after the bank's page template is set.
// Skipped rows are counted (`notes`), never inferred into something listable.
//
// Honesty (D3, H12/H13, OPS-A4):
//   - fromRecruiterBank = true (the normalizer sets it from the provider);
//   - employerVerified ONLY from the bank's verified-employer record;
//   - a GoHire job is an agency posting (代招) unless the bank states the
//     employer is verified; only then may it carry 企业直招. A verified
//     employer's job is stated as NOT an agency posting (isAgency false, not
//     "unknown"), so a row first stored as 代招 loses that label on the sync
//     after the bank verifies its employer (the upsert keeps a stored value
//     when the incoming one is null); a staffing firm's name still marks it;
//   - publicDisplay = true ONLY when the bank records the employer's consent
//     to syndicate. Today's bank schema has neither field, so both read false
//     through `readBankEmployerSignals` on the database and list transports
//     until RoboHire/GoHire add them (handoff: Schema requests
//     SR-16b-3/SR-16b-4). The syndication endpoint states both for every job.

import { bankApiConfig, bankDisabledReason, bankMarket, bankSyndicationConfig, bankTransport, getBankClient, isBankEnabled, type BankApiConfig } from '../../../../roboapply/v2/lib/raBankClients.js';
import { BANK_PUBLIC_JOB_URL_TEMPLATE_ENV, bankDisplayName, bankPublicJobUrl, bankPublicJobUrlTemplate } from '../../../../roboapply/v2/lib/raCrossBankMatch.js';
import { createHash } from 'node:crypto';
import type { ExtendedPrismaClient } from '../../../../lib/prisma.js';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { inputFromBankJob, type ProviderJobInput } from '../../normalize/index.js';
import { bankPageSize } from '../config.js';
import type { JobSourceAdapter, SourceClosure, SourceFetchContext, SourceFetchResult, SourceQuery, SourceTransport } from '../../sources/index.js';
import { SYNDICATION_TIMEOUT_MS, SyndicationError, createSyndicationReader, syndicationUrlProblem } from './syndication.js';

export type BankId = 'robohire' | 'gohire';

/** Columns read from the recruiter bank. Never internal notes, AI caches or tenant data. */
export const BANK_SYNC_SELECT = {
  id: true,
  status: true,
  publishedAt: true,
  updatedAt: true,
  title: true,
  description: true,
  qualifications: true,
  hardRequirements: true,
  niceToHave: true,
  benefits: true,
  location: true,
  locations: true,
  workType: true,
  employmentType: true,
  experienceLevel: true,
  education: true,
  headcount: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryText: true,
  companyName: true,
  requiredKeywordSet: true,
  company: { select: { id: true, name: true, logoUrl: true, website: true, industry: true, size: true, headcount: true, founded: true } },
} as const;

/** A bank Job row as selected (structural, so tests need no client). */
export interface BankSyncRow {
  id: string;
  status: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
  title: string | null;
  description?: string | null;
  qualifications?: string | null;
  hardRequirements?: string | null;
  niceToHave?: string | null;
  benefits?: string | null;
  location?: string | null;
  locations?: unknown;
  workType?: string | null;
  employmentType?: string | null;
  experienceLevel?: string | null;
  /** 学历要求: the bank's enum ('bachelor', 'associate' …) or the Chinese word ('本科'). */
  education?: string | null;
  /** 招聘人数. */
  headcount?: number | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  salaryText?: string | null;
  companyName?: string | null;
  requiredKeywordSet?: string[] | null;
  company?: {
    id?: string | null;
    name?: string | null;
    logoUrl?: string | null;
    website?: string | null;
    industry?: string | null;
    size?: string | null;
    headcount?: number | null;
    founded?: number | null;
  } | null;
  // The four fields below are stated by the syndication endpoint only (./syndication.ts).
  // Today's bank schema has none of them, so a database or list row never carries one.
  /** The bank's verified-employer record for this job's employer. */
  employerVerified?: boolean;
  /** When the employer's consent to syndicate was recorded (null: none on record). */
  syndicationConsentAt?: Date | string | null;
  /** The start of the posting's validity (carried, never used to hold a row: see GOHIRE_SYNDICATION.md). */
  validFrom?: Date | null;
  /** The instant the posting's validity ends: stored as RAJob.expiresAt; a passed one closes the row. */
  validUntil?: Date | null;
}

export interface BankEmployerSignals {
  employerVerified: boolean;
  syndicationConsent: boolean;
}

/**
 * The bank's verified-employer and consent-to-syndicate records for a job.
 * Narrow typed adapter: reads `employerVerified` / `syndicationConsentAt`
 * when the bank row carries them (a future bank schema), else false. Never
 * inferred from anything else (OPS-A4, D3).
 */
export function readBankEmployerSignals(row: object): BankEmployerSignals {
  const r = row as Record<string, unknown>;
  const company = (r.company && typeof r.company === 'object' ? r.company : {}) as Record<string, unknown>;
  return {
    employerVerified: r.employerVerified === true || company.employerVerified === true,
    syndicationConsent: r.syndicationConsentAt instanceof Date || (typeof r.syndicationConsentAt === 'string' && r.syndicationConsentAt !== ''),
  };
}

/** True when a bank job may sync: open AND published (drafts never sync). */
export function isSyncableBankJob(row: Pick<BankSyncRow, 'status' | 'publishedAt'>): boolean {
  return row.status === 'open' && row.publishedAt != null;
}

/**
 * Whether a bank provider's candidate-facing posting page is configured, and
 * the setting that names it (the admin sources panel). Null for a provider
 * that is not a recruiter bank.
 */
export function bankPublicPageState(provider: string, env: Record<string, string | undefined> = process.env): { configured: boolean; variable: string } | null {
  const bank: BankId | null = provider === 'bank_gohire' ? 'gohire' : provider === 'bank_robohire' ? 'robohire' : null;
  if (!bank) return null;
  return { configured: bankPublicJobUrlTemplate(bank, env) !== null, variable: BANK_PUBLIC_JOB_URL_TEMPLATE_ENV[bank] };
}

// ── Row classification (one rule for every transport) ─────────────────────

/** The words that make a title a test posting when nothing else is in it. */
const TEST_WORD_RE = /测试|\b(?:test(?:ing)?|demo)\b/i;
/**
 * Filler a recruiter puts around them ("测试岗位请勿投递", "内部测试职位 2", "test job - please ignore"),
 * and the name of the recruiter product's own feature being tried out: 简历匹配 (resume
 * matching). 「测试简历匹配」 is the test posting the research note records in the GoHire
 * bank (JOB_SOURCES_CN.md §2.3); it names a feature, not a job.
 */
const TEST_FILLER_RE =
  /测试|请勿投递|請勿投遞|勿投递|勿投遞|请勿投|勿投|请勿|岗位|崗位|职位|職位|数据|數據|内部|內部|专用|專用|样例|示例|简历|簡歷|匹配|\b(?:test(?:ing)?|demo|job|jobs|position|posting|role|dummy|sample|internal|please|ignore|do|not|apply)\b/gi;

/**
 * A recruiter's test posting: a title that is nothing but 测试 / test / demo
 * and filler (岗位, 职位, 数据, 请勿投递, 简历匹配, digits, punctuation). Everything
 * else is a job. The gate is applied to every transport (database, list and
 * syndication) through `classifyBankRow`, and each skip is counted
 * ('bank_test_posting').
 *
 * MARKET_STRATEGY §1.4 says "titles containing 测试". 测试 is also the ordinary
 * word for testing work, so that rule would hide real jobs (软件测试工程师,
 * 电池测试技术员, 晶圆测试操作员, 射频测试) and count them as test postings. The
 * rule here only drops a title that names no job at all; a real posting is
 * never hidden on a guess (D3). The owner's ruling on the documented wording
 * is asked for in the bundle handoff.
 */
export function isBankTestPosting(title: string | null | undefined): boolean {
  if (typeof title !== 'string') return false;
  const t = title.normalize('NFKC').replace(/測試/g, '测试');
  if (!TEST_WORD_RE.test(t)) return false;
  return t.replace(TEST_FILLER_RE, '').replace(/[\s\d\p{P}\p{S}]/gu, '') === '';
}

export type BankRowVerdict = 'ok' | 'closed' | 'unpublished' | 'validity_ended' | 'no_company' | 'test_posting';

/**
 * What a bank row is, before the posting-page rule. Pure. With `now`, a row
 * whose stated validity has ended is 'validity_ended' (MARKET_STRATEGY §1.5
 * "Closure": mainland, source validity when stated); a row that states none
 * never closes by date.
 */
export function classifyBankRow(row: BankSyncRow, now?: Date): BankRowVerdict {
  if (row.status !== 'open') return 'closed';
  if (row.publishedAt == null) return 'unpublished';
  if (now && row.validUntil instanceof Date && row.validUntil.getTime() <= now.getTime()) return 'validity_ended';
  const company = (row.companyName ?? '').trim() || (row.company?.name ?? '').trim();
  if (!company || !(row.title ?? '').trim()) return 'no_company';
  if (isBankTestPosting(row.title)) return 'test_posting';
  return 'ok';
}

// ── Cursors ───────────────────────────────────────────────────────────────

/** Marks a database / syndication cursor written while the bank had no posting page. */
const NO_PAGE_MARK = 'nopage';
/** Marks a cursor written while the bank had a posting page: "page:<8 hex of the template's hash>". */
const PAGE_MARK_RE = /^page:[0-9a-f]{8}$/;

/**
 * The mark of a cursor written with this posting-page template. The apply
 * link of every stored row was built from the template the sync ran with, so
 * the mark names it: a cursor with another mark (no page, another template, or
 * none at all, which is a cursor older than the posting-page rule) says the
 * stored rows may carry a link that is not this page.
 */
export function bankPageMark(template: string | null): string {
  return template ? `page:${createHash('sha256').update(template, 'utf8').digest('hex').slice(0, 8)}` : NO_PAGE_MARK;
}

/** "<ISO>|<id>" (optionally "|nopage" or "|page:<hash>", then "|<pass start ISO>") → the position; null for no/invalid cursor (full sync). */
export function parseBankCursor(cursor: string | null | undefined): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id, mark] = cursor.split('|');
  if (!iso || !id || (mark !== undefined && mark !== NO_PAGE_MARK && !PAGE_MARK_RE.test(mark))) return null;
  const updatedAt = new Date(iso);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, id };
}

/** The mark of a stored cursor: 'nopage', 'page:<hash>', or null for an unmarked (pre-rule) or invalid cursor. */
export function bankCursorMark(cursor: string | null | undefined): string | null {
  if (typeof cursor !== 'string' || parseBankCursor(cursor) === null) return null;
  return cursor.split('|')[2] ?? null;
}

/** True when the cursor was written while the bank's rows were held (no posting page). */
export function cursorWrittenWithoutPage(cursor: string | null | undefined): boolean {
  return bankCursorMark(cursor) === NO_PAGE_MARK;
}

/**
 * When the pass a stored cursor belongs to began reading the bank from its
 * beginning (the cursor's fourth part). Null for no cursor, an invalid one, or
 * one written before the re-read rule.
 */
export function bankCursorPassStart(cursor: string | null | undefined): Date | null {
  if (typeof cursor !== 'string' || parseBankCursor(cursor) === null) return null;
  const iso = cursor.split('|')[3];
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Whether a bank's cursor sync is read again from the beginning (header: "Seen again"): only a
 * bank whose rows are in the mainland market, the one market where a row unseen for 45 days is
 * archived (jobs-maintain, step "mainland, unseen"). RoboHire's rows are international: no rule
 * reads their lastSeenAt, so its sync stays the parity wave's.
 */
export function bankRereads(bank: BankId): boolean {
  return bankMarket(bank) === 'cn';
}

/** Days after which the mainland bank's cursor sync reads the bank again from the beginning (header: "Seen again"). */
export const BANK_RESYNC_DAYS = 7;
/** The longest interval an operator may set: it must stay well inside the 45 days after which an unseen mainland row is archived. */
export const BANK_RESYNC_MAX_DAYS = 30;
const DAY_MS = 86_400_000;

/** `INGEST_BANK_RESYNC_DAYS` when it is a whole number from 1 to 30, else 7. */
export function bankResyncDays(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.INGEST_BANK_RESYNC_DAYS ?? '').trim();
  const days = Number(raw);
  return raw !== '' && Number.isInteger(days) && days >= 1 && days <= BANK_RESYNC_MAX_DAYS ? days : BANK_RESYNC_DAYS;
}

export function formatBankCursor(row: Pick<BankSyncRow, 'updatedAt' | 'id'>): string {
  return `${row.updatedAt.toISOString()}|${row.id}`;
}

/** Prisma `where` for rows after the cursor (ordered by updatedAt, id). */
export function bankCursorWhere(cursor: { updatedAt: Date; id: string } | null): Prisma.JobWhereInput {
  if (!cursor) return {};
  return { OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }] };
}

/** The list transport's cursor: "api|<pass start ISO>|<next page>" (page 1 = start a new pass). */
export function parseApiCursor(cursor: string | null | undefined): { passStart: Date; page: number } | null {
  if (!cursor) return null;
  const [tag, iso, page] = cursor.split('|');
  if (tag !== 'api' || !iso || !page) return null;
  const passStart = new Date(iso);
  const n = Number(page);
  if (Number.isNaN(passStart.getTime()) || !Number.isInteger(n) || n < 1) return null;
  return { passStart, page: n };
}

export function formatApiCursor(passStart: Date, nextPage: number): string {
  return `api|${passStart.toISOString()}|${nextPage}`;
}

// ── Mapping ───────────────────────────────────────────────────────────────

export interface BankRowMapOptions {
  /** The job's page on the bank's site (default: raCrossBankMatch.bankPublicJobUrl). */
  publicJobUrl?: (bank: BankId, id: string) => string | null;
}

/**
 * One bank row → normalizer input. Null when the row cannot be shown: no
 * title or employer, or the bank has no candidate-facing posting page (the
 * caller holds such a row; it is never listed with a dead link).
 */
export function inputFromBankSyncRow(bank: BankId, row: BankSyncRow, now: Date, options: BankRowMapOptions = {}): ProviderJobInput | null {
  const applyUrl = (options.publicJobUrl ?? bankPublicJobUrl)(bank, row.id);
  if (!applyUrl) return null;
  const signals = readBankEmployerSignals(row);
  const input = inputFromBankJob(
    {
      id: row.id,
      title: row.title,
      description: row.description ?? null,
      qualifications: row.qualifications ?? null,
      hardRequirements: row.hardRequirements ?? null,
      niceToHave: row.niceToHave ?? null,
      benefits: row.benefits ?? null,
      location: row.location ?? null,
      locations: row.locations,
      workType: row.workType ?? null,
      employmentType: row.employmentType ?? null,
      experienceLevel: row.experienceLevel ?? null,
      education: row.education ?? null,
      headcount: row.headcount ?? null,
      salaryMin: row.salaryMin ?? null,
      salaryMax: row.salaryMax ?? null,
      salaryCurrency: row.salaryCurrency ?? null,
      salaryPeriod: row.salaryPeriod ?? null,
      salaryText: row.salaryText ?? null,
      publishedAt: row.publishedAt,
      companyName: row.companyName ?? null,
      company: row.company ? { id: row.company.id ?? null, name: row.company.name ?? null, logoUrl: row.company.logoUrl ?? null } : null,
      requiredKeywordSet: row.requiredKeywordSet ?? null,
    },
    bank,
    {
      applyUrl,
      employerVerified: signals.employerVerified,
      syndicationConsent: signals.syndicationConsent,
      // GoHire postings are placed by recruiters for a named employer: 代招 unless the bank says the employer is verified.
      agencyPosting: bank === 'gohire' ? !signals.employerVerified : null,
    },
  );
  if (!input) return null;
  // The bank's verified-employer record says the named company posts this job itself. That is a
  // statement, not an absence of one: the job is marked "not an agency posting" (false), so the
  // upsert overwrites a 代招 stored while the employer was unverified (a null would keep it). Our
  // own staffing-firm list and name rule still win: such an employer stays an agency.
  if (bank === 'gohire' && signals.employerVerified) input.isAgency = false;
  const c = row.company;
  if (c && (c.website || c.industry || c.size || c.headcount || c.founded)) {
    input.companyFacts = {
      source: `bank:${bank}`,
      fetchedAt: now,
      website: c.website ?? null,
      industries: c.industry ? [c.industry] : null,
      size: c.size ?? null,
      employeeCount: c.headcount ?? null,
      foundedYear: c.founded ?? null,
    };
  }
  input.sourcePublisher = null; // the bank itself is the source (sourceName = RoboHire / GoHire)
  // The bank's own validity is the posting's stated deadline (stored as RAJob.expiresAt). A row
  // that states none keeps none: a bank row never expires by its age (M-22).
  if (row.validUntil instanceof Date && !Number.isNaN(row.validUntil.getTime())) input.expiresAt = row.validUntil;
  return input;
}

// ── The HTTP whitelist ────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function dateOrNull(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `[{ country, city }]` and nothing else from a locations value. */
function pickLocations(v: unknown): Array<{ city: string | null; country: string | null }> | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(isObj).map((l) => ({ city: strOrNull(l.city), country: strOrNull(l.country) }));
  return out.length ? out : null;
}

/**
 * The strict whitelist of the LIST endpoint (the interim reader): one HTTP
 * response row → a BankSyncRow holding ONLY the BANK_SYNC_SELECT fields, each
 * type-checked. Everything else in the response row is dropped here, before
 * any log, error or write can see it. Null for a row without an id. (The
 * syndication endpoint has its own schema: ./syndication.ts.)
 */
export function pickBankSyncRow(raw: unknown): BankSyncRow | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : typeof raw.id === 'number' ? String(raw.id) : null;
  if (!id) return null;
  const row: BankSyncRow = {
    id,
    status: strOrNull(raw.status),
    publishedAt: dateOrNull(raw.publishedAt),
    updatedAt: dateOrNull(raw.updatedAt) ?? new Date(0),
    title: strOrNull(raw.title),
    description: strOrNull(raw.description),
    qualifications: strOrNull(raw.qualifications),
    hardRequirements: strOrNull(raw.hardRequirements),
    niceToHave: strOrNull(raw.niceToHave),
    benefits: strOrNull(raw.benefits),
    location: strOrNull(raw.location),
    locations: pickLocations(raw.locations),
    workType: strOrNull(raw.workType),
    employmentType: strOrNull(raw.employmentType),
    experienceLevel: strOrNull(raw.experienceLevel),
    education: strOrNull(raw.education),
    headcount: numOrNull(raw.headcount),
    salaryMin: numOrNull(raw.salaryMin),
    salaryMax: numOrNull(raw.salaryMax),
    salaryCurrency: strOrNull(raw.salaryCurrency),
    salaryPeriod: strOrNull(raw.salaryPeriod),
    salaryText: strOrNull(raw.salaryText),
    companyName: strOrNull(raw.companyName),
    requiredKeywordSet: Array.isArray(raw.requiredKeywordSet) ? raw.requiredKeywordSet.filter((k): k is string => typeof k === 'string') : null,
    // The list rows carry companyName but not the company relation.
    company: null,
  };
  return row;
}

// ── HTTP readers ──────────────────────────────────────────────────────────

/** Rows per page of the GoHire list endpoint (its maximum). */
export const BANK_API_PAGE_SIZE = 50;
/** Pages one pass may read (2,000 published rows). */
export const BANK_API_MAX_PAGES = 40;
/** Per-request timeout. */
export const BANK_API_TIMEOUT_MS = 20_000;
/**
 * A pass that runs longer than this is cut short and resumed by the next
 * fetch. The caller's remaining budget (SourceFetchContext.budgetMs) lowers it.
 */
export const BANK_API_PASS_BUDGET_MS = 100_000;
/** The shortest timeout a request is given when the budget is nearly spent. */
export const BANK_API_MIN_REQUEST_MS = 2_000;

/** The part of a fetch Response the bank readers use. `headers` and `body` are optional: a test fake may give `text()` alone. */
export interface BankFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<unknown> } } | null;
  text(): Promise<string>;
}

export type BankFetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<BankFetchResponse>;

/** A bank HTTP failure. The message is a short code; it never carries a response body or the key. */
export class BankApiError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'BankApiError';
  }
}

export interface BankHttpDeps {
  fetch?: BankFetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function getBankJson(url: string, key: string, deps: BankHttpDeps): Promise<unknown> {
  if (deps.signal?.aborted) throw new BankApiError('aborted');
  const doFetch: BankFetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? BANK_API_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'X-API-Key': key }, redirect: 'error' });
    if (res.status >= 300 && res.status < 400) throw new BankApiError('redirect');
    if (!res.ok) throw new BankApiError(`http_${res.status}`);
    const body = await res.text();
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new BankApiError('not_json');
    }
  } catch (err) {
    if (err instanceof BankApiError) throw err;
    // Never the underlying message: an error text can quote the URL or a body.
    throw new BankApiError(controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

export interface BankApiPage {
  /** Whitelisted rows, in the endpoint's order (published first). */
  rows: BankSyncRow[];
  /** Open jobs the key's user can see, as the endpoint counts them (null when it sends no count). */
  total: number | null;
  /** True when the endpoint has pages after this one. */
  more: boolean;
}

/**
 * One page of the GoHire list endpoint (the interim reader behind the
 * BankPageReader seam): open rows, published first. One request; rows are
 * whitelisted before they leave this function. Throws BankApiError.
 */
export async function readBankPageViaApi(config: BankApiConfig, page: number, deps: BankHttpDeps = {}): Promise<BankApiPage> {
  const url = `${config.base}/api/v1/jobs?status=open&sortBy=aging&limit=${BANK_API_PAGE_SIZE}&page=${page}`;
  const body = await getBankJson(url, config.key, deps);
  if (!isObj(body) || !Array.isArray(body.data)) throw new BankApiError('unexpected_shape');
  const rows = body.data.map((r) => pickBankSyncRow(r)).filter((r): r is BankSyncRow => !!r);
  const pagination = isObj(body.pagination) ? body.pagination : {};
  const total = numOrNull(pagination.total);
  const totalPages = numOrNull(pagination.totalPages);
  const more = pagination.hasMore === true || (totalPages !== null ? page < totalPages : body.data.length >= BANK_API_PAGE_SIZE);
  return { rows, total, more };
}

/**
 * One page of a cursor transport when the source says more than its rows: the
 * syndication endpoint names the jobs that left its listing, its own position
 * and whether more follows. The database reader returns the rows alone (the
 * position is its last row; a full page means more).
 */
export interface BankCursorPage {
  rows: BankSyncRow[];
  /** Jobs the source says left its listing since the cursor (tombstones): closed as 'bank_closed'. */
  closedIds?: string[];
  /** The position after this page. Absent: the last row read. */
  next?: { updatedAt: Date; id: string } | null;
  /** Whether the source has entries after this page. Absent: a full page means more. */
  more?: boolean;
  /** Counters of the read itself (never a posting field). */
  notes?: Record<string, number>;
}

/** Reads one page of bank rows after the cursor. Null: the bank cannot be reached through this reader. */
export type BankPageReader = (bank: BankId, cursor: { updatedAt: Date; id: string } | null, take: number) => Promise<BankSyncRow[] | BankCursorPage | null>;

/** Default reader: the bank's typed Prisma client (read-only). Null when the bank is unreachable. */
export const readBankPage: BankPageReader = async (bank, cursor, take) => {
  const client: ExtendedPrismaClient | null = getBankClient(bank);
  if (!client) return null;
  const rows = await client.job.findMany({
    where: bankCursorWhere(cursor),
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take,
    select: BANK_SYNC_SELECT,
  });
  return rows as unknown as BankSyncRow[];
};

// The syndication endpoint as a BankPageReader is `createSyndicationReader` in ./syndication.ts.

// ── The adapter ───────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

export interface BankAdapterDeps {
  /** Database-transport reader override (tests). Giving one selects the 'db' transport unless `transport` says otherwise. */
  read?: BankPageReader;
  isEnabled?: () => boolean;
  pageSize?: () => number;
  /** Transport override (tests); default: raBankClients.bankTransport ('syndication' whenever GOHIRE_SYNDICATION_URL is set). */
  transport?: () => SourceTransport;
  /** HTTP client override (tests). */
  fetch?: BankFetchLike;
  /** Environment for the HTTP configuration and the posting-page template (default process.env). */
  env?: Env;
  timeoutMs?: number;
  /** Response cap of the syndication reader in bytes (tests); default SYNDICATION_MAX_BYTES. */
  maxBytes?: number;
  passBudgetMs?: number;
  /** Wall clock (tests). */
  clock?: () => number;
}

function bump(notes: Record<string, number>, key: string, by = 1): void {
  if (by > 0) notes[key] = (notes[key] ?? 0) + by;
}

interface Sorted {
  jobs: ProviderJobInput[];
  /** Ids of the rows emitted as jobs. */
  listed: string[];
  /** Rows the bank closed, unpublished, let run out of validity, left without an employer or marked as a test. */
  closed: string[];
  /** Listable rows held because the bank has no posting page. */
  held: string[];
}

/** Sorts a page of rows into jobs, closures and held rows, counting each skip reason. */
function sortRows(bank: BankId, rows: readonly BankSyncRow[], now: Date, notes: Record<string, number>, publicJobUrl: (bank: BankId, id: string) => string | null): Sorted {
  const out: Sorted = { jobs: [], listed: [], closed: [], held: [] };
  for (const row of rows) {
    const verdict = classifyBankRow(row, now);
    if (verdict !== 'ok') {
      out.closed.push(row.id);
      if (verdict === 'unpublished') bump(notes, 'bank_unpublished');
      else if (verdict === 'validity_ended') bump(notes, 'bank_validity_ended');
      else if (verdict === 'no_company') bump(notes, 'bank_no_company');
      else if (verdict === 'test_posting') bump(notes, 'bank_test_posting');
      else bump(notes, 'bank_closed');
      continue;
    }
    bump(notes, 'bank_synced');
    const input = inputFromBankSyncRow(bank, row, now, { publicJobUrl });
    if (!input) {
      out.held.push(row.id);
      bump(notes, 'bank_no_public_page');
      continue;
    }
    out.jobs.push(input);
    out.listed.push(row.id);
  }
  return out;
}

export function createBankAdapter(bank: BankId, deps: BankAdapterDeps = {}): JobSourceAdapter {
  const provider = bank === 'gohire' ? 'bank_gohire' : 'bank_robohire';
  const env = (): Env => deps.env ?? process.env;
  const apiConfig = (): BankApiConfig | null => bankApiConfig(bank, env());
  const publicJobUrl = (b: BankId, id: string) => bankPublicJobUrl(b, id, env());
  const transport = (): SourceTransport => {
    if (deps.transport) return deps.transport();
    if (deps.read) return 'db';
    return bankTransport(bank, env());
  };
  const closures = (held: string[]): SourceClosure[] => (held.length ? [{ externalIds: held, reason: 'no_apply_target' }] : []);

  /**
   * Cursor transports: the database, or the syndication endpoint. `shortened` says the request's
   * time limit was cut to what the ingest tick could still give (the syndication reader only).
   */
  async function fetchByCursor(read: BankPageReader, query: SourceQuery, now: Date, shortened = false): Promise<SourceFetchResult> {
    const take = deps.pageSize?.() ?? bankPageSize();
    const template = bankPublicJobUrlTemplate(bank, env());
    const hasPage = template !== null;
    const mark = bankPageMark(template);
    const raw = query.params.cursor ?? null;
    // With a posting page, only a cursor written with this same page is continued. Any other one
    // restarts from the beginning, once: rows read while the bank had no page were held, not stored
    // ('nopage'); rows stored before the posting-page rule (an unmarked cursor) or under another
    // template carry a link that is not this page, and reading them again rewrites it.
    const pageChanged = hasPage && bankCursorMark(raw) !== mark;
    // Seen again (header; the mainland bank only): the pass this cursor belongs to began too long
    // ago, or the cursor was written before passes were dated. The bank is read from its beginning,
    // so every job it still lists is confirmed and its row's lastSeenAt moves. Any other bank's
    // cursor is never dated and never restarted for its age.
    const rereads = bankRereads(bank);
    const started = rereads ? bankCursorPassStart(raw) : null;
    const rereadDue = rereads && parseBankCursor(raw) !== null && (started === null || now.getTime() - started.getTime() >= bankResyncDays(env()) * DAY_MS);
    const stored = pageChanged || rereadDue ? null : raw;
    const cursor = parseBankCursor(stored);
    const passStart = cursor !== null && started !== null ? started : now;
    let answer: BankSyncRow[] | BankCursorPage | null;
    try {
      answer = await read(bank, cursor, take);
    } catch (err) {
      // A request whose time limit was shortened to fit the tick and then ran out is a sync cut
      // short, not a failed one (the list transport's rule for a later page): a healthy endpoint
      // that needs longer than the few seconds left must not be shown as failing and deferred for
      // an hour in the middle of a pass. Nothing was read: the stored cursor stays as it is and the
      // query stays due, so the next tick asks again with a full limit. A timeout at the request's
      // own full limit is still an error.
      if (shortened && err instanceof SyndicationError && err.message === 'timeout') {
        return { jobs: [], calls: 1, cursor: raw, exhausted: false, notes: { bank_pass_cut_short: 1 } };
      }
      // An HTTP reader's error is a short code by construction (never a URL, a key or a body);
      // the database reader's is the driver's message, as before.
      const detail = err instanceof BankApiError || err instanceof SyndicationError ? err.message : err instanceof Error ? err.message.slice(0, 160) : 'error';
      return { jobs: [], calls: 1, error: `${bankDisplayName(bank)} bank read failed: ${detail}` };
    }
    if (answer === null) return { jobs: [], calls: 0, error: 'bank_unavailable' };
    const page: BankCursorPage = Array.isArray(answer) ? { rows: answer } : answer;
    const rows = page.rows;
    const notes: Record<string, number> = { ...(page.notes ?? {}) };
    if (rereadDue && !pageChanged) bump(notes, 'bank_reread_started');
    const sorted = sortRows(bank, rows, now, notes, publicJobUrl);
    // Tombstones: the source says these jobs left its listing. Counted with the bank's other closures.
    const emitted = new Set(sorted.listed);
    const tombstones = (page.closedIds ?? []).filter((id) => !emitted.has(id));
    bump(notes, 'bank_closed', tombstones.length);
    const closed = [...new Set([...sorted.closed, ...tombstones])];
    const last = rows[rows.length - 1];
    // The source's own position when it states one, else the last row read, else where we were.
    const at = page.next !== undefined ? (page.next ?? cursor) : (last ?? cursor);
    const position = at ? formatBankCursor(at) : null;
    // Every cursor says which posting page (or none) its rows were read with; the mainland bank's
    // also says when its pass began.
    const next = position ? (rereads ? `${position}|${mark}|${passStart.toISOString()}` : `${position}|${mark}`) : null;
    return {
      jobs: sorted.jobs,
      calls: 1,
      closedExternalIds: closed,
      closures: closures(sorted.held),
      // No posting page: nothing of this bank is listable, so every open row of it is closed
      // ('no_apply_target'), including rows stored before the rule existed.
      listing: hasPage ? null : { externalIds: [], reason: 'no_apply_target' },
      notes,
      cursor: next,
      exhausted: page.more !== undefined ? !page.more : rows.length < take,
    };
  }

  /** The list transport: one pass over the published rows, with the listing diff when it completes. */
  async function fetchByList(config: BankApiConfig, query: SourceQuery, ctx: SourceFetchContext): Promise<SourceFetchResult> {
    const clock = deps.clock ?? (() => Date.now());
    const startedAt = clock();
    // The pass's own cap, and never more than the caller can still give (the ingest tick's
    // remaining budget): brands share one cron budget and GoApply runs second.
    const budget = Math.min(deps.passBudgetMs ?? BANK_API_PASS_BUDGET_MS, ctx.budgetMs ?? Number.POSITIVE_INFINITY);
    const requestTimeout = deps.timeoutMs ?? BANK_API_TIMEOUT_MS;
    const resume = parseApiCursor(query.params.cursor);
    const resumed = !!resume && resume.page > 1;
    const passStart = resumed ? resume!.passStart : ctx.now;
    let page = resumed ? resume!.page : 1;
    const rows: BankSyncRow[] = [];
    let calls = 0;
    let total: number | null = null;
    let complete = false;
    let cutShort = false;
    while (page <= BANK_API_MAX_PAGES) {
      const left = budget - (clock() - startedAt);
      if (calls > 0 && (ctx.signal?.aborted || left <= 0)) {
        cutShort = true;
        break;
      }
      // A request never outlives the budget. Only the first one of a fetch gets a short try
      // whatever is left, so a fetch always makes progress or reports a real error.
      const floor = calls === 0 ? Math.min(BANK_API_MIN_REQUEST_MS, requestTimeout) : 1;
      const timeoutMs = Math.max(floor, Math.min(requestTimeout, left));
      let res: BankApiPage;
      try {
        calls += 1;
        res = await readBankPageViaApi(config, page, { fetch: deps.fetch, timeoutMs, signal: ctx.signal });
      } catch (err) {
        // A later page that ran out of the budget (its timeout was shortened to fit) is a pass cut
        // short, not a failed one: the pages read so far are kept and the next run resumes here.
        if (calls > 1 && timeoutMs < requestTimeout && err instanceof BankApiError && err.message === 'timeout') {
          cutShort = true;
          break;
        }
        // A failed pass writes nothing and closes nothing; the next run starts a new pass.
        return { jobs: [], calls, error: `${bankDisplayName(bank)} bank read failed: ${err instanceof BankApiError ? err.message : 'error'}` };
      }
      total = res.total ?? total;
      const firstUnpublished = res.rows.findIndex((r) => r.publishedAt == null);
      rows.push(...(firstUnpublished === -1 ? res.rows : res.rows.slice(0, firstUnpublished)));
      page += 1;
      // Published rows come first: the first unpublished row ends the pass.
      if (firstUnpublished !== -1 || !res.more || res.rows.length === 0) {
        complete = true;
        break;
      }
    }
    const notes: Record<string, number> = {};
    const sorted = sortRows(bank, rows, ctx.now, notes, publicJobUrl);
    // Open requisitions the recruiter never published: the endpoint's own count minus the published rows read.
    if (complete && !resumed && total !== null) bump(notes, 'bank_unpublished', Math.max(0, total - rows.length));
    if (!complete && !cutShort) bump(notes, 'bank_page_cap');
    if (cutShort) bump(notes, 'bank_pass_cut_short');
    // Only a pass read from its first page to its end knows the whole listing.
    const whole = complete && !resumed;
    return {
      jobs: sorted.jobs,
      calls,
      closedExternalIds: sorted.closed,
      closures: closures(sorted.held),
      listing: whole ? { externalIds: sorted.listed, reason: 'bank_closed' } : null,
      notes,
      cursor: formatApiCursor(passStart, cutShort ? page : 1),
      exhausted: !cutShort,
    };
  }

  return {
    provider,
    kind: 'cursor',
    markets: [bankMarket(bank)],
    sourceBoards: [bank],
    isEnabled: () => {
      try {
        return deps.isEnabled ? deps.isEnabled() : isBankEnabled(bank);
      } catch {
        return false;
      }
    },
    transport,
    disabledReason: () => (deps.isEnabled ? null : bankDisabledReason(bank, env())),
    supportsCountry: () => true,
    dailyCallLimit: () => null,
    async fetch(query, ctx): Promise<SourceFetchResult> {
      const via = transport();
      if (via === 'db') return fetchByCursor(deps.read ?? readBankPage, query, ctx.now);
      if (via === 'syndication') {
        const syndication = bankSyndicationConfig(bank, env());
        if (!syndication) return { jobs: [], calls: 0, error: 'bank_unavailable' };
        // TLS only: a plain-http endpoint on a public host is refused here, before any request.
        const problem = syndicationUrlProblem(syndication.url);
        if (problem) return { jobs: [], calls: 0, error: problem };
        // One request per fetch, inside its own 20 s and never longer than the tick can still give
        // (with a floor, so a nearly spent tick still makes a real attempt). A request that runs out
        // of a limit shortened this way is a sync cut short; one that runs out of its full limit is
        // an error.
        const fullTimeoutMs = deps.timeoutMs ?? SYNDICATION_TIMEOUT_MS;
        const timeoutMs = Math.min(fullTimeoutMs, Math.max(BANK_API_MIN_REQUEST_MS, ctx.budgetMs ?? Number.POSITIVE_INFINITY));
        const reader = createSyndicationReader(syndication, { fetch: deps.fetch, timeoutMs, maxBytes: deps.maxBytes, signal: ctx.signal });
        return fetchByCursor(reader, query, ctx.now, timeoutMs < fullTimeoutMs);
      }
      const config = apiConfig();
      if (via === 'api' && config) return fetchByList(config, query, ctx);
      return { jobs: [], calls: 0, error: 'bank_unavailable' };
    },
  };
}
