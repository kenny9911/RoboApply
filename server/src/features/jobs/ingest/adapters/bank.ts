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
//   syndication  GoHire only, when GOHIRE_SYNDICATION_URL is set: the same
//                cursor over HTTPS; a tombstone row closes its job.
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
// The cross-tenant guard (RA_CROSSBANK_CROSS_TENANT_CONFIRMED) and the GoHire
// TLS rule (CN-E-05: sslmode=require, or HTTPS) live in raBankClients.
//
// What may be read (D3, privacy): the columns of BANK_SYNC_SELECT and nothing
// else. An HTTP response row is cut down to that whitelist in memory before
// anything is logged or stored, so no other field of the response (notes,
// evaluationRules, passingScore, aiInsights, clientKey, organizationId …) can
// reach a log line, an error message or a column. Errors carry a status code,
// never a response body.
//
// What is listed (the same rule for both banks):
//   - open AND published (`isSyncableBankJob`) with a named employer;
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
//     employer is verified; only then may it carry 企业直招;
//   - publicDisplay = true ONLY when the bank records the employer's consent
//     to syndicate. Today's bank schema has neither field, so both read false
//     through `readBankEmployerSignals` until RoboHire/GoHire add them
//     (handoff: Schema requests SR-16b-3/SR-16b-4).

import { bankApiConfig, bankDisabledReason, bankMarket, bankTransport, getBankClient, isBankEnabled, type BankApiConfig } from '../../../../roboapply/v2/lib/raBankClients.js';
import { BANK_PUBLIC_JOB_URL_TEMPLATE_ENV, bankDisplayName, bankPublicJobUrl, bankPublicJobUrlTemplate } from '../../../../roboapply/v2/lib/raCrossBankMatch.js';
import { createHash } from 'node:crypto';
import type { ExtendedPrismaClient } from '../../../../lib/prisma.js';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { inputFromBankJob, type ProviderJobInput } from '../../normalize/index.js';
import { bankPageSize } from '../config.js';
import type { JobSourceAdapter, SourceClosure, SourceFetchContext, SourceFetchResult, SourceQuery, SourceTransport } from '../../sources/index.js';

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
/** Filler a recruiter puts around them ("测试岗位请勿投递", "内部测试职位 2", "test job - please ignore"). */
const TEST_FILLER_RE =
  /测试|请勿投递|請勿投遞|勿投递|勿投遞|请勿投|勿投|请勿|岗位|崗位|职位|職位|数据|數據|内部|內部|专用|專用|样例|示例|\b(?:test(?:ing)?|demo|job|jobs|position|posting|role|dummy|sample|internal|please|ignore|do|not|apply)\b/gi;

/**
 * A recruiter's test posting: a title that is nothing but 测试 / test / demo
 * and filler (岗位, 职位, 数据, 请勿投递, digits, punctuation). Everything else
 * is a job.
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

export type BankRowVerdict = 'ok' | 'closed' | 'unpublished' | 'no_company' | 'test_posting';

/** What a bank row is, before the posting-page rule. Pure. */
export function classifyBankRow(row: BankSyncRow): BankRowVerdict {
  if (row.status !== 'open') return 'closed';
  if (row.publishedAt == null) return 'unpublished';
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

/** "<ISO>|<id>" (optionally "|nopage" or "|page:<hash>") → parts; null for no/invalid cursor (full sync). */
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

const COMPANY_FIELDS = Object.keys(BANK_SYNC_SELECT.company.select) as Array<keyof (typeof BANK_SYNC_SELECT)['company']['select']>;

/** The whitelisted company fields of a syndication row (the list endpoint sends no company). */
function pickCompany(v: unknown): BankSyncRow['company'] {
  if (!isObj(v)) return null;
  const out: Record<string, unknown> = {};
  for (const key of COMPANY_FIELDS) {
    const raw = v[key];
    out[key] = key === 'headcount' || key === 'founded' ? numOrNull(raw) : strOrNull(raw);
  }
  // The bank's verified-employer record, when the endpoint states it.
  if (v.employerVerified === true) out.employerVerified = true;
  return out as BankSyncRow['company'];
}

export interface PickBankRowOptions {
  /** Syndication rows may carry the company relation, the employer signals and a tombstone mark. */
  syndication?: boolean;
}

/**
 * The strict whitelist: one HTTP response row → a BankSyncRow holding ONLY the
 * BANK_SYNC_SELECT fields, each type-checked. Everything else in the response
 * row is dropped here, before any log, error or write can see it. Null for a
 * row without an id.
 */
export function pickBankSyncRow(raw: unknown, options: PickBankRowOptions = {}): BankSyncRow | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : typeof raw.id === 'number' ? String(raw.id) : null;
  if (!id) return null;
  const tombstone = options.syndication === true && (raw.deleted === true || raw.tombstone === true || dateOrNull(raw.deletedAt) !== null);
  const row: BankSyncRow = {
    id,
    // A tombstone closes its job whatever status the row repeats.
    status: tombstone ? 'closed' : strOrNull(raw.status),
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
    company: options.syndication ? pickCompany(raw.company) : null,
  };
  if (options.syndication) {
    const signals = row as BankSyncRow & { employerVerified?: boolean; syndicationConsentAt?: string };
    if (raw.employerVerified === true) signals.employerVerified = true;
    const consent = dateOrNull(raw.syndicationConsentAt);
    if (consent) signals.syndicationConsentAt = consent.toISOString();
  }
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

export type BankFetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

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

/** Reads one page of bank rows after the cursor. */
export type BankPageReader = (bank: BankId, cursor: { updatedAt: Date; id: string } | null, take: number) => Promise<BankSyncRow[] | null>;

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

/**
 * The syndication endpoint as a BankPageReader (the target transport, once
 * the GoHire backend has the route):
 *   GET <GOHIRE_SYNDICATION_URL>?cursor=<updatedAt ISO>|<id>&limit=<n>   X-API-Key
 *   → { data: [ row… ] } ordered by (updatedAt, id), rows after the cursor.
 * A row is the BANK_SYNC_SELECT columns (plus the company relation,
 * employerVerified and syndicationConsentAt when the bank has them). A
 * tombstone is a row with `deleted: true` (or `deletedAt`): it closes its job.
 */
export function createSyndicationReader(config: BankApiConfig, deps: BankHttpDeps = {}): BankPageReader {
  return async (_bank, cursor, take) => {
    if (!config.syndicationUrl) return null;
    const url = new URL(config.syndicationUrl);
    if (cursor) url.searchParams.set('cursor', formatBankCursor(cursor));
    url.searchParams.set('limit', String(take));
    const body = await getBankJson(url.toString(), config.key, deps);
    if (!isObj(body) || !Array.isArray(body.data)) throw new BankApiError('unexpected_shape');
    return body.data.map((r) => pickBankSyncRow(r, { syndication: true })).filter((r): r is BankSyncRow => !!r);
  };
}

// ── The adapter ───────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

export interface BankAdapterDeps {
  /** Database-transport reader override (tests). Giving one selects the 'db' transport unless `transport` says otherwise. */
  read?: BankPageReader;
  isEnabled?: () => boolean;
  pageSize?: () => number;
  /** Transport override (tests); default: raBankClients.bankTransport + GOHIRE_SYNDICATION_URL. */
  transport?: () => SourceTransport;
  /** HTTP client override (tests). */
  fetch?: BankFetchLike;
  /** Environment for the HTTP configuration and the posting-page template (default process.env). */
  env?: Env;
  timeoutMs?: number;
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
  /** Rows the bank closed, unpublished, left without an employer or marked as a test. */
  closed: string[];
  /** Listable rows held because the bank has no posting page. */
  held: string[];
}

/** Sorts a page of rows into jobs, closures and held rows, counting each skip reason. */
function sortRows(bank: BankId, rows: readonly BankSyncRow[], now: Date, notes: Record<string, number>, publicJobUrl: (bank: BankId, id: string) => string | null): Sorted {
  const out: Sorted = { jobs: [], listed: [], closed: [], held: [] };
  for (const row of rows) {
    const verdict = classifyBankRow(row);
    if (verdict !== 'ok') {
      out.closed.push(row.id);
      if (verdict === 'unpublished') bump(notes, 'bank_unpublished');
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
    const t = bankTransport(bank, env());
    if (t !== 'api') return t;
    return apiConfig()?.syndicationUrl ? 'syndication' : 'api';
  };
  const closures = (held: string[]): SourceClosure[] => (held.length ? [{ externalIds: held, reason: 'no_apply_target' }] : []);

  /** Cursor transports: the database, or the syndication endpoint. */
  async function fetchByCursor(read: BankPageReader, query: SourceQuery, now: Date): Promise<SourceFetchResult> {
    const take = deps.pageSize?.() ?? bankPageSize();
    const template = bankPublicJobUrlTemplate(bank, env());
    const hasPage = template !== null;
    const mark = bankPageMark(template);
    // With a posting page, only a cursor written with this same page is continued. Any other one
    // restarts from the beginning, once: rows read while the bank had no page were held, not stored
    // ('nopage'); rows stored before the posting-page rule (an unmarked cursor) or under another
    // template carry a link that is not this page, and reading them again rewrites it.
    const stored = hasPage && bankCursorMark(query.params.cursor) !== mark ? null : (query.params.cursor ?? null);
    const cursor = parseBankCursor(stored);
    let rows: BankSyncRow[] | null;
    try {
      rows = await read(bank, cursor, take);
    } catch (err) {
      const detail = err instanceof BankApiError ? err.message : err instanceof Error ? err.message.slice(0, 160) : 'error';
      return { jobs: [], calls: 1, error: `${bankDisplayName(bank)} bank read failed: ${detail}` };
    }
    if (rows === null) return { jobs: [], calls: 0, error: 'bank_unavailable' };
    const notes: Record<string, number> = {};
    const sorted = sortRows(bank, rows, now, notes, publicJobUrl);
    const last = rows[rows.length - 1];
    const position = last ? formatBankCursor(last) : cursor ? formatBankCursor(cursor) : null;
    // Every cursor says which posting page (or none) its rows were read with.
    const next = position ? `${position}|${mark}` : null;
    return {
      jobs: sorted.jobs,
      calls: 1,
      closedExternalIds: sorted.closed,
      closures: closures(sorted.held),
      // No posting page: nothing of this bank is listable, so every open row of it is closed
      // ('no_apply_target'), including rows stored before the rule existed.
      listing: hasPage ? null : { externalIds: [], reason: 'no_apply_target' },
      notes,
      cursor: next,
      exhausted: rows.length < take,
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
      const config = apiConfig();
      if (via === 'syndication' && config?.syndicationUrl) {
        return fetchByCursor(createSyndicationReader(config, { fetch: deps.fetch, timeoutMs: deps.timeoutMs, signal: ctx.signal }), query, ctx.now);
      }
      if (via === 'api' && config) return fetchByList(config, query, ctx);
      return { jobs: [], calls: 0, error: 'bank_unavailable' };
    },
  };
}
