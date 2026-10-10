// components/features/copilot/cards/model.ts — what each Assistant card's
// `data` looks like on the client, and tolerant parsers for it (WP-51;
// ARCHITECTURE.md §5.4; F-ORION-12).
//
// The wire contract (`CopilotCard { type, id, data, sources? }`) leaves `data`
// open. These shapes are what the cards render; WP-50 produces them (handoff
// request). A card whose data does not parse renders NOTHING, exactly like an
// unknown card type, so a server change can never crash the conversation or
// render a half-filled card with invented values (D3).
//
// Safety: links inside cards are either app paths ("/…", never "//…") or
// http(s) URLs; anything else is dropped.

import type { FitTierKey } from '../../common';
import type { FilterSet } from '../../../../lib/api/contracts/search';
import type { FeedItem, FeedSort } from '../../../../lib/api/contracts/feed';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown, max = 20): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s).slice(0, max) : []);

/** An app path ("/resume/abc") — never protocol-relative or a scheme. Pure. */
export function safeAppPath(v: unknown): string | null {
  const s = str(v);
  if (!s || !s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return null;
  return s;
}

/** An http(s) URL, or null. Pure. */
export function safeExternalUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const TIERS: readonly FitTierKey[] = ['great', 'good', 'possible', 'unlikely'];
const tierOf = (v: unknown): FitTierKey | null => (typeof v === 'string' && (TIERS as readonly string[]).includes(v) ? (v as FitTierKey) : null);

/** Proposal lifecycle as the server reports it on reload. */
export type CardProposalStatus = 'pending' | 'applied' | 'dismissed' | 'expired';
const statusOf = (v: unknown): CardProposalStatus => (v === 'applied' || v === 'dismissed' || v === 'expired' ? v : 'pending');

export interface SourcedWire<T = unknown> {
  value: T;
  source: string;
  sampleSize?: number;
  asOf: string;
  method?: string;
  url?: string;
}

function sourced<T>(v: unknown, check: (x: unknown) => x is T): SourcedWire<T> | null {
  if (!isObj(v) || !str(v.source) || !str(v.asOf)) return null;
  if (v.value !== null && !check(v.value)) return null;
  return {
    value: v.value as T,
    source: v.source as string,
    asOf: v.asOf as string,
    ...(num(v.sampleSize) !== null ? { sampleSize: num(v.sampleSize) as number } : {}),
    ...(str(v.method) ? { method: str(v.method) as string } : {}),
    ...(safeExternalUrl(v.url) ? { url: safeExternalUrl(v.url) as string } : {}),
  };
}

const anyValue = (_x: unknown): _x is unknown => true;

/**
 * A card's `sources` list, validated like every sourced value inside `data`:
 * an entry without a string `source` and `asOf` is dropped (SourceNote would
 * throw on it), and `url` survives only as an http(s) URL. At most 10. Pure.
 */
export function parseSources(v: unknown): SourcedWire[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 10)
    .map((x) => sourced(x, anyValue))
    .filter((x): x is SourcedWire => x !== null);
}

// ── job_list ─────────────────────────────────────────────────────────────

export interface JobListRow {
  jobId: string;
  title: string;
  company: string | null;
  location: string | null;
  pay: FeedItem['pay'];
  tier: FitTierKey | null;
  score: number | null;
}
export interface JobListData {
  items: JobListRow[];
}

/**
 * The post's pay. A pay unit the source did not state is never invented: with
 * no valid period the figures are dropped and only the post's own text (if
 * any) is kept, which renders without a unit.
 */
export function payOf(v: unknown): FeedItem['pay'] {
  if (!isObj(v)) return null;
  const period = v.period;
  const okPeriod = period === 'year' || period === 'month' || period === 'week' || period === 'day' || period === 'hour';
  const text = str(v.text);
  if (!okPeriod) return text ? { min: null, max: null, currency: '', period: 'year', text } : null;
  return {
    min: num(v.min),
    max: num(v.max),
    currency: str(v.currency) ?? '',
    period,
    text,
  };
}

export function parseJobList(d: unknown): JobListData | null {
  if (!isObj(d)) return null;
  const raw = Array.isArray(d.items) ? d.items : Array.isArray(d.jobs) ? d.jobs : null;
  if (!raw) return null;
  const items: JobListRow[] = [];
  for (const r of raw.slice(0, 8)) {
    if (!isObj(r)) continue;
    const jobId = str(r.jobId) ?? str(r.id);
    const title = str(r.title);
    if (!jobId || !title) continue;
    const company = isObj(r.company) ? str(r.company.name) : str(r.company);
    const fit = isObj(r.fit) ? r.fit : r;
    items.push({ jobId, title, company, location: str(r.location), pay: payOf(r.pay), tier: tierOf(fit.tier), score: num(fit.score) });
  }
  return { items };
}

// ── filters / filter_diff / action ───────────────────────────────────────

export interface FiltersData {
  filters: FilterSet;
  searchProfileId: string | null;
}
export function parseFilters(d: unknown): FiltersData | null {
  if (!isObj(d) || !isObj(d.filters)) return null;
  return { filters: d.filters as FilterSet, searchProfileId: str(d.searchProfileId) };
}

export interface FilterOpWire {
  op: 'add' | 'remove' | 'set';
  path: string;
  value: unknown;
}
export interface FilterDiffData {
  proposalId: string;
  searchProfileId: string;
  baseVersion: number;
  ops: FilterOpWire[];
  /** Jobs the saved search shows with the change (our index, the user's own search). */
  countAfter: number | null;
  expiresAt: string | null;
  status: CardProposalStatus;
}
export function parseFilterDiff(d: unknown): FilterDiffData | null {
  if (!isObj(d)) return null;
  const proposalId = str(d.proposalId);
  const searchProfileId = str(d.searchProfileId);
  const baseVersion = num(d.baseVersion);
  if (!proposalId || !searchProfileId || baseVersion === null || !Array.isArray(d.ops)) return null;
  const ops: FilterOpWire[] = [];
  for (const o of d.ops) {
    if (!isObj(o) || (o.op !== 'add' && o.op !== 'remove' && o.op !== 'set') || !str(o.path)) continue;
    ops.push({ op: o.op, path: o.path as string, value: o.value });
  }
  if (ops.length === 0) return null;
  const countAfter = num(d.countAfter) ?? (isObj(d.count) ? num(d.count.after) : null);
  return { proposalId, searchProfileId, baseVersion, ops, countAfter, expiresAt: str(d.expiresAt), status: statusOf(d.status) };
}

const SORTS: readonly FeedSort[] = ['recommended', 'newest', 'best_fit', 'highest_pay', 'deadline'];
export interface ActionData {
  kind: 'set_sort';
  sort: FeedSort;
}
export function parseAction(d: unknown): ActionData | null {
  if (!isObj(d)) return null;
  const kind = d.kind ?? d.action;
  if (kind === 'set_sort' && typeof d.sort === 'string' && (SORTS as readonly string[]).includes(d.sort)) return { kind: 'set_sort', sort: d.sort as FeedSort };
  return null;
}

// ── fit_analysis ─────────────────────────────────────────────────────────

export interface FitAnalysisData {
  jobId: string;
  tier: FitTierKey | null;
  score: number | null;
  aligned: string[];
  missing: string[];
  highlights: string[];
}
export function parseFitAnalysis(d: unknown): FitAnalysisData | null {
  if (!isObj(d) || !str(d.jobId)) return null;
  const aligned = strList(d.aligned ?? d.overlap);
  const missing = strList(d.missing ?? d.gaps);
  const highlights = strList(d.highlights);
  if (aligned.length + missing.length + highlights.length === 0 && !tierOf(d.tier) && num(d.score) === null) return null;
  return { jobId: d.jobId as string, tier: tierOf(d.tier), score: num(d.score), aligned, missing, highlights };
}

// ── company ──────────────────────────────────────────────────────────────

export const COMPANY_FACT_KEYS = ['industry', 'size', 'founded', 'headquarters', 'website', 'sponsorship_filings'] as const;
export type CompanyFactKey = (typeof COMPANY_FACT_KEYS)[number];
export interface CompanyData {
  name: string;
  facts: Array<{ key: CompanyFactKey; value: SourcedWire<string | number> }>;
}
const isStrOrNum = (x: unknown): x is string | number => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));
export function parseCompany(d: unknown): CompanyData | null {
  if (!isObj(d) || !str(d.name) || !Array.isArray(d.facts)) return null;
  const facts: CompanyData['facts'] = [];
  for (const f of d.facts) {
    if (!isObj(f) || !(COMPANY_FACT_KEYS as readonly string[]).includes(f.key as string)) continue;
    const value = sourced(f.value, isStrOrNum);
    if (value) facts.push({ key: f.key as CompanyFactKey, value });
  }
  return { name: d.name as string, facts };
}

// ── contacts ─────────────────────────────────────────────────────────────

export interface ContactsData {
  company: string | null;
  people: Array<{ id: string; name: string; title: string | null; sourceName: string }>;
  searchLinks: Array<{ url: string }>;
}
export function parseContacts(d: unknown): ContactsData | null {
  if (!isObj(d)) return null;
  const people: ContactsData['people'] = [];
  for (const p of Array.isArray(d.people) ? d.people : []) {
    // No named source → not shown (honesty: never a person without a source).
    if (!isObj(p) || !str(p.id) || !str(p.name) || !str(p.sourceName)) continue;
    people.push({ id: p.id as string, name: p.name as string, title: str(p.title), sourceName: p.sourceName as string });
  }
  const searchLinks: ContactsData['searchLinks'] = [];
  for (const l of Array.isArray(d.searchLinks) ? d.searchLinks : []) {
    const url = safeExternalUrl(isObj(l) ? l.url : l);
    if (url) searchLinks.push({ url });
  }
  if (people.length === 0 && searchLinks.length === 0) return null;
  return { company: str(d.company), people, searchLinks };
}

// ── credit_action ────────────────────────────────────────────────────────

export const CREDIT_ACTIONS = ['tailor', 'cover_letter', 'outreach', 'job_import'] as const;
export type CreditActionKind = (typeof CREDIT_ACTIONS)[number];
export interface CreditActionData {
  proposalId: string;
  action: CreditActionKind;
  bucket: string;
  cost: number;
  jobId: string | null;
  jobTitle: string | null;
  company: string | null;
  url: string | null;
  expiresAt: string | null;
  status: CardProposalStatus;
}
export function parseCreditAction(d: unknown): CreditActionData | null {
  if (!isObj(d) || !str(d.proposalId) || !(CREDIT_ACTIONS as readonly string[]).includes(d.action as string) || !str(d.bucket)) return null;
  const cost = num(d.cost);
  if (cost === null || cost < 0) return null;
  return {
    proposalId: d.proposalId as string,
    action: d.action as CreditActionKind,
    bucket: d.bucket as string,
    cost,
    jobId: str(d.jobId),
    jobTitle: str(d.jobTitle),
    company: str(d.company),
    url: safeExternalUrl(d.url),
    expiresAt: str(d.expiresAt),
    status: statusOf(d.status),
  };
}

// ── tailor_ready / cover_letter / job_imported / competitiveness ─────────

export interface LinkData {
  href: string;
  jobTitle: string | null;
  company: string | null;
}
export function parseTailorReady(d: unknown): LinkData | null {
  if (!isObj(d)) return null;
  const href = safeAppPath(d.href) ?? (str(d.resumeId) ? `/resume/${encodeURIComponent(d.resumeId as string)}` : null);
  return href ? { href, jobTitle: str(d.jobTitle), company: str(d.company) } : null;
}

export interface CoverLetterData extends LinkData {
  preview: string | null;
}
export function parseCoverLetter(d: unknown): CoverLetterData | null {
  if (!isObj(d)) return null;
  const href = safeAppPath(d.href) ?? (str(d.letterId) ? `/resume/letters/${encodeURIComponent(d.letterId as string)}` : null);
  if (!href) return null;
  const preview = str(d.preview);
  return { href, jobTitle: str(d.jobTitle), company: str(d.company), preview: preview ? preview.slice(0, 600) : null };
}

export interface JobImportedData {
  jobId: string;
  title: string;
  company: string | null;
}
export function parseJobImported(d: unknown): JobImportedData | null {
  if (!isObj(d) || !str(d.jobId) || !str(d.title)) return null;
  return { jobId: d.jobId as string, title: d.title as string, company: isObj(d.company) ? str(d.company.name) : str(d.company) };
}

export interface CompetitivenessData {
  href: string;
}
export function parseCompetitiveness(d: unknown): CompetitivenessData | null {
  if (!isObj(d)) return null;
  const href = safeAppPath(d.href) ?? (str(d.jobId) ? `/jobs/report?job=${encodeURIComponent(d.jobId as string)}` : null);
  return href && href.startsWith('/jobs/report') ? { href } : null;
}

// ── interview_plan ───────────────────────────────────────────────────────

export type QuestionSourceKind = 'bank' | 'posting' | 'ai';
export interface InterviewPlanData {
  jobId: string;
  questions: Array<{ text: string; sourceKind: QuestionSourceKind | null }>;
}
export function parseInterviewPlan(d: unknown): InterviewPlanData | null {
  if (!isObj(d) || !str(d.jobId) || !Array.isArray(d.questions)) return null;
  const questions: InterviewPlanData['questions'] = [];
  for (const q of d.questions.slice(0, 12)) {
    const text = isObj(q) ? str(q.text) : str(q);
    if (!text) continue;
    const k = isObj(q) ? q.sourceKind : null;
    questions.push({ text, sourceKind: k === 'bank' || k === 'posting' || k === 'ai' ? k : null });
  }
  return questions.length ? { jobId: d.jobId as string, questions } : null;
}

// ── salary ───────────────────────────────────────────────────────────────

export interface PayRange {
  min: number | null;
  max: number | null;
  currency: string;
  period: 'year' | 'month' | 'week' | 'day' | 'hour';
}
export interface SalaryData {
  title: string | null;
  location: string | null;
  range: SourcedWire<PayRange | null>;
}
const isRange = (x: unknown): x is PayRange =>
  isObj(x) && !!str(x.currency) && (num(x.min) !== null || num(x.max) !== null) && ['year', 'month', 'week', 'day', 'hour'].includes(x.period as string);
export function parseSalary(d: unknown): SalaryData | null {
  if (!isObj(d)) return null;
  const range = sourced(d.range, isRange);
  // An aggregate of posted ranges: without its sample size N the one-sample
  // rule (D3: N ≥ MIN_SAMPLE, and N is shown) cannot be checked, so nothing renders.
  if (!range || typeof range.sampleSize !== 'number') return null;
  return { title: str(d.title), location: str(d.location), range };
}

// ── applications ─────────────────────────────────────────────────────────

export interface ApplicationsData {
  counts: Array<{ status: string; count: number }>;
  followUps: Array<{ jobId: string; title: string; company: string | null; dueAt: string | null }>;
}
export function parseApplications(d: unknown): ApplicationsData | null {
  if (!isObj(d)) return null;
  const counts: ApplicationsData['counts'] = [];
  for (const c of Array.isArray(d.counts) ? d.counts : []) {
    if (isObj(c) && str(c.status) && num(c.count) !== null) counts.push({ status: c.status as string, count: num(c.count) as number });
  }
  const followUps: ApplicationsData['followUps'] = [];
  for (const f of Array.isArray(d.followUps) ? d.followUps.slice(0, 8) : []) {
    if (isObj(f) && str(f.jobId) && str(f.title)) followUps.push({ jobId: f.jobId as string, title: f.title as string, company: isObj(f.company) ? str(f.company.name) : str(f.company), dueAt: str(f.dueAt) });
  }
  if (counts.length === 0 && followUps.length === 0) return null;
  return { counts, followUps };
}

// ── memory_add ───────────────────────────────────────────────────────────

export interface MemoryAddData {
  proposalId: string;
  fact: string;
  expiresAt: string | null;
  status: CardProposalStatus;
}
export function parseMemoryAdd(d: unknown): MemoryAddData | null {
  if (!isObj(d) || !str(d.proposalId) || !str(d.fact)) return null;
  return { proposalId: d.proposalId as string, fact: (d.fact as string).slice(0, 500), expiresAt: str(d.expiresAt), status: statusOf(d.status) };
}

// ── profile_gaps ─────────────────────────────────────────────────────────

export interface ProfileGapsData {
  gaps: Array<{ key: string; href: string }>;
}
export function parseProfileGaps(d: unknown): ProfileGapsData | null {
  if (!isObj(d) || !Array.isArray(d.gaps)) return null;
  const gaps: ProfileGapsData['gaps'] = [];
  for (const g of d.gaps.slice(0, 10)) {
    const key = isObj(g) ? str(g.key) : str(g);
    if (!key) continue;
    gaps.push({ key, href: (isObj(g) ? safeAppPath(g.href) : null) ?? '/profile' });
  }
  return gaps.length ? { gaps } : null;
}

// ── notice ───────────────────────────────────────────────────────────────

export const NOTICE_CODES = ['credits_exhausted', 'copilot_budget_exhausted', 'ai_unavailable', 'content_blocked', 'rate_limited', 'proposal_expired'] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];
export interface NoticeData {
  code: NoticeCode;
}
export function parseNotice(d: unknown): NoticeData | null {
  if (!isObj(d)) return null;
  const code = d.code === 'daily_limit' ? 'credits_exhausted' : d.code;
  return (NOTICE_CODES as readonly string[]).includes(code as string) ? { code: code as NoticeCode } : null;
}

// ── campus_deadlines (GoApply) ───────────────────────────────────────────

export interface CampusDeadlinesData {
  items: Array<{ company: string; programme: string | null; closesAt: string | null; sourceUrl: string; sourceName: string }>;
}
export function parseCampusDeadlines(d: unknown): CampusDeadlinesData | null {
  if (!isObj(d) || !Array.isArray(d.items)) return null;
  const items: CampusDeadlinesData['items'] = [];
  for (const i of d.items.slice(0, 10)) {
    if (!isObj(i)) continue;
    const company = str(i.company);
    const sourceUrl = safeExternalUrl(i.sourceUrl);
    const sourceName = str(i.sourceName);
    // Official link + named source are required (CN plan: official-link-only listings).
    if (!company || !sourceUrl || !sourceName) continue;
    items.push({ company, programme: str(i.programme), closesAt: str(i.closesAt), sourceUrl, sourceName });
  }
  return items.length ? { items } : null;
}
