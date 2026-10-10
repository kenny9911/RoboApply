// components/features/copilot/cards/model.ts — what each Assistant card's
// `data` looks like on the client, and tolerant parsers for it (WP-51;
// ARCHITECTURE.md §5.4; F-ORION-12).
//
// The wire contract (`CopilotCard { type, id, data, sources? }`) leaves `data`
// open. Each parser reads what the WP-50 tool that produces the card sends
// (server/src/features/copilot/tools/*.ts, proposals.ts; typed card payloads
// in server/src/features/copilot/contract.ts) and maps it to what the card
// renders. cards.test.tsx renders the real tools' output, so a server shape
// change shows up as a failing test. A card whose data does not parse renders
// NOTHING, exactly like an unknown card type, so a server change can never
// crash the conversation or render a half-filled card with invented values (D3).
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

/**
 * Proposal lifecycle as the server reports it in `data.status` (also on
 * reload). `conflict`: the saved search changed and the server closed this
 * proposal (a fresh filter_diff card follows it).
 */
export type CardProposalStatus = 'pending' | 'applied' | 'dismissed' | 'expired' | 'conflict';
const statusOf = (v: unknown): CardProposalStatus => (v === 'applied' || v === 'dismissed' || v === 'expired' || v === 'conflict' ? v : 'pending');

/** The initial state of a proposal card's buttons from the server's `data.status` and expiry. Pure. */
export function initialProposalStatus(status: CardProposalStatus, expired: boolean): 'pending' | 'applied' | 'dismissed' | 'expired' | 'conflict' {
  if (status !== 'pending') return status;
  return expired ? 'expired' : 'pending';
}

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
/**
 * A job count as the server sends it (`CountView { count: Sourced<number> | null, capped }`).
 * `value` null = not known (renders "—", never 0); `capped` = the real number
 * is at least `value` (renders "N+"). `sourced` carries the source and date
 * for the SourceNote line.
 */
export interface CountData {
  value: number | null;
  capped: boolean;
  sourced: SourcedWire<number> | null;
}
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

/**
 * `CountView` → `CountData`. A bare number (no source, no date) is not a
 * count we can show (D3: every number that is not the user's own is Sourced),
 * so it parses as unknown. Pure.
 */
export function parseCount(v: unknown): CountData {
  const unknown: CountData = { value: null, capped: false, sourced: null };
  if (!isObj(v)) return unknown;
  const count = sourced(v.count, isCount);
  if (!count || count.value === null) return unknown;
  return { value: count.value, capped: v.capped === true, sourced: count };
}

export interface FilterDiffData {
  proposalId: string;
  searchProfileId: string;
  baseVersion: number;
  ops: FilterOpWire[];
  /** Jobs the saved search shows now (our index, the user's own search). */
  countBefore: CountData;
  /** Jobs it would show with the change. */
  countAfter: CountData;
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
  return {
    proposalId,
    searchProfileId,
    baseVersion,
    ops,
    countBefore: parseCount(d.countBefore),
    countAfter: parseCount(d.countAfter),
    expiresAt: str(d.expiresAt),
    status: statusOf(d.status),
  };
}

/**
 * The fresh `filter_diff` card a 409 version_conflict carries in
 * `details.card` (a new pending proposal against the search as it is now), or
 * null when the server sent none (nothing is left to change). Pure.
 */
export function conflictCard(details: unknown): { type: 'filter_diff'; id: string; data: unknown } | null {
  if (!isObj(details) || !isObj(details.card)) return null;
  const c = details.card;
  if (c.type !== 'filter_diff' || !str(c.id) || !parseFilterDiff(c.data)) return null;
  return { type: 'filter_diff', id: c.id as string, data: c.data };
}

const SORTS: readonly FeedSort[] = ['recommended', 'newest', 'best_fit', 'highest_pay', 'deadline'];
/** Where an `open_link` action card may point (server `ActionCardData` labels). */
export const OPEN_LINK_LABELS = ['people', 'resume', 'resume_check', 'added_jobs', 'report', 'practice', 'job'] as const;
export type OpenLinkLabel = (typeof OPEN_LINK_LABELS)[number];
export type ActionData = { kind: 'set_sort'; sort: FeedSort } | { kind: 'open_link'; href: string; label: OpenLinkLabel };
export function parseAction(d: unknown): ActionData | null {
  if (!isObj(d)) return null;
  const kind = d.kind ?? d.action;
  if (kind === 'set_sort' && typeof d.sort === 'string' && (SORTS as readonly string[]).includes(d.sort)) return { kind: 'set_sort', sort: d.sort as FeedSort };
  if (kind === 'open_link') {
    const href = safeAppPath(d.href);
    const label = (OPEN_LINK_LABELS as readonly string[]).includes(d.label as string) ? (d.label as OpenLinkLabel) : null;
    return href && label ? { kind: 'open_link', href, label } : null;
  }
  return null;
}

// ── fit_analysis ─────────────────────────────────────────────────────────

export interface FitAnalysisData {
  jobId: string;
  tier: FitTierKey | null;
  score: number | null;
  /** Deterministic: the post's skills the resume or profile shows (`skills.aligned`). */
  aligned: string[];
  /** Deterministic: the post's skills it does not show (`skills.missing`). */
  missing: string[];
  /** AI-written strengths (empty for a quick estimate). */
  highlights: string[];
  /** AI-written observations about the resume (empty for a quick estimate). */
  gaps: string[];
  /** The text above came from the AI read (`kind: 'ai'`), not a quick estimate. */
  aiWritten: boolean;
}
/** `MatchFitView` (+ `aiWritten`) from the analyze_fit tool. Pure. */
export function parseFitAnalysis(d: unknown): FitAnalysisData | null {
  if (!isObj(d) || !str(d.jobId)) return null;
  const skills = isObj(d.skills) ? d.skills : {};
  const aligned = strList(skills.aligned);
  const missing = strList(skills.missing);
  const highlights = strList(d.strengths);
  const gaps = strList(d.gaps);
  if (aligned.length + missing.length + highlights.length + gaps.length === 0 && !tierOf(d.tier) && num(d.score) === null) return null;
  return { jobId: d.jobId as string, tier: tierOf(d.tier), score: num(d.score), aligned, missing, highlights, gaps, aiWritten: d.kind === 'ai' || d.aiWritten === true };
}

// ── company ──────────────────────────────────────────────────────────────

export const COMPANY_FACT_KEYS = ['industry', 'size', 'founded', 'headquarters', 'website', 'sponsorship_filings'] as const;
export type CompanyFactKey = (typeof COMPANY_FACT_KEYS)[number];
export interface CompanyData {
  name: string;
  facts: Array<{ key: CompanyFactKey; value: SourcedWire<string | number> }>;
}
const isStrOrNum = (x: unknown): x is string | number => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));
/** `CompanyProfile` from company_insights: `facts` is a record `{ industry: SourcedFact, … }`; unsourced fields are absent. Pure. */
export function parseCompany(d: unknown): CompanyData | null {
  if (!isObj(d) || !str(d.name) || !isObj(d.facts)) return null;
  const facts: CompanyData['facts'] = [];
  for (const key of COMPANY_FACT_KEYS) {
    const value = sourced(d.facts[key], isStrOrNum);
    if (value && value.value !== null) facts.push({ key, value });
  }
  return { name: d.name as string, facts };
}

// ── contacts ─────────────────────────────────────────────────────────────

export const CONTACT_SOURCES = ['user_connections_import', 'user_added', 'bank_recruiter'] as const;
export type ContactSourceKind = (typeof CONTACT_SOURCES)[number];
export interface ContactsData {
  company: string | null;
  /** `source` names where the person comes from; a recruiter also needs its bank's `sourceName`. */
  people: Array<{ id: string; name: string; title: string | null; source: ContactSourceKind; sourceName: string | null; recruiter: boolean }>;
  searchLinks: Array<{ url: string }>;
}
/** `ConnectionsForJobResponse` (+ jobId) from find_connections. Pure. */
export function parseContacts(d: unknown): ContactsData | null {
  if (!isObj(d)) return null;
  const people: ContactsData['people'] = [];
  const seen = new Set<string>();
  let company: string | null = null;
  const groups: Array<[unknown, boolean]> = [
    [d.recruiters, true],
    [d.fromYourCompanies, false],
    [d.fromYourSchools, false],
  ];
  for (const [list, recruiter] of groups) {
    for (const p of Array.isArray(list) ? list.slice(0, 10) : []) {
      if (!isObj(p) || !str(p.id) || !str(p.fullName) || seen.has(p.id as string)) continue;
      const source = (CONTACT_SOURCES as readonly string[]).includes(p.source as string) ? (p.source as ContactSourceKind) : null;
      const sourceName = str(p.sourceName);
      // No named source → not shown (honesty: never a person without a source).
      if (!source || (source === 'bank_recruiter' && !sourceName)) continue;
      seen.add(p.id as string);
      company = company ?? str(p.companyName);
      people.push({ id: p.id as string, name: p.fullName as string, title: str(p.title), source, sourceName, recruiter });
    }
  }
  const searchLinks: ContactsData['searchLinks'] = [];
  for (const l of Array.isArray(d.searchLinks) ? d.searchLinks : []) {
    const url = safeExternalUrl(isObj(l) ? l.url : l);
    if (url) searchLinks.push({ url });
  }
  if (people.length === 0 && searchLinks.length === 0) return null;
  return { company: str(d.company) ?? company, people, searchLinks };
}

// ── credit_action ────────────────────────────────────────────────────────

export const CREDIT_ACTIONS = ['tailor', 'cover_letter', 'outreach', 'job_import', 'rewrite'] as const;
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

// ── outreach draft (the result of an applied `outreach` credit action) ───

export interface OutreachDraftData {
  /** The draft text, for the user to copy and send themselves. */
  text: string;
  subject: string | null;
  /** The job's People tab, where the draft is kept. */
  href: string | null;
}
/**
 * `{ card: action open_link → People tab, draft: { text, subject, jobId } }`
 * from an applied outreach proposal. Nothing is sent anywhere (D1). Pure.
 */
export function parseOutreachDraft(result: unknown): OutreachDraftData | null {
  if (!isObj(result) || !isObj(result.draft)) return null;
  const text = str(result.draft.text);
  if (!text) return null;
  const link = isObj(result.card) ? parseAction(result.card.data) : null;
  const jobId = str(result.draft.jobId);
  const href = link && link.kind === 'open_link' ? link.href : jobId ? `/jobs/${encodeURIComponent(jobId)}?tab=people` : null;
  return { text: text.slice(0, 5000), subject: str(result.draft.subject), href };
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
  /** Set when the job is in the user's list; null = the user still has to finish the import. */
  jobId: string | null;
  /** The job page, or Added jobs to finish the import. */
  href: string;
  title: string | null;
  company: string | null;
}
/** `JobImportedCardData` (server contract) after an applied job_import. Pure. */
export function parseJobImported(d: unknown): JobImportedData | null {
  if (!isObj(d)) return null;
  const jobId = str(d.jobId);
  const href = jobId ? `/jobs/${encodeURIComponent(jobId)}` : safeAppPath(d.href);
  if (!href) return null;
  return { jobId, href, title: str(d.title), company: isObj(d.company) ? str(d.company.name) : str(d.company) };
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
/** The job's own pay as its post states it: a range with a unit, or only the post's text. */
export interface PostedPay {
  range: PayRange | null;
  text: string | null;
}
export interface SalaryData {
  title: string | null;
  location: string | null;
  /** This job's post (source `posting`), when the tool was asked about one job and it lists pay. */
  posted: SourcedWire<PostedPay> | null;
  /** The middle half (p25–p75) of listed pay across matching posts in our index; value null below MIN_SAMPLE. */
  range: SourcedWire<PayRange | null> | null;
}
const PERIODS = ['year', 'month', 'week', 'day', 'hour'];
const isRange = (x: unknown): x is PayRange =>
  isObj(x) && !!str(x.currency) && (num(x.min) !== null || num(x.max) !== null) && PERIODS.includes(x.period as string);
const isPostedPay = (x: unknown): x is Obj => isObj(x) && (isRange(x) || !!str(x.text));

/**
 * `{ posted, stats, jobId }` from salary_context: `posted` is the job's own
 * listed pay (Sourced, `posting`), `stats` the SalaryStatsResult (percentiles
 * Sourced with their sample size; counts as Sourced). Pure.
 */
export function parseSalary(d: unknown): SalaryData | null {
  if (!isObj(d)) return null;
  let posted: SalaryData['posted'] = null;
  const postedWire = sourced(d.posted, isPostedPay);
  if (postedWire && isObj(postedWire.value)) {
    const v = postedWire.value;
    const range = isRange(v) ? { min: num(v.min), max: num(v.max), currency: str(v.currency) as string, period: v.period as PayRange['period'] } : null;
    posted = { ...postedWire, value: { range, text: str(v.text) } };
  }
  let range: SalaryData['range'] = null;
  const stats = isObj(d.stats) ? d.stats : null;
  const isNum = (x: unknown): x is number => num(x) !== null;
  if (stats) {
    const median = sourced(stats.median, isNum);
    const p25 = sourced(stats.p25, isNum);
    const p75 = sourced(stats.p75, isNum);
    const listed = sourced(stats.listedCount, isNum);
    if (median && median.value !== null) {
      const value = { min: p25?.value ?? median.value, max: p75?.value ?? median.value, currency: str(stats.currency) ?? '', period: stats.period as PayRange['period'] };
      // An aggregate without its sample size N cannot pass the one-sample rule (D3), so it is not shown.
      if (isRange(value) && typeof median.sampleSize === 'number') range = { ...median, value };
    } else if (listed && listed.value !== null) {
      // Below MIN_SAMPLE: no figure, only "not enough data" with N.
      range = { value: null, source: listed.source, asOf: listed.asOf, sampleSize: listed.value, ...(listed.method ? { method: listed.method } : {}) };
    }
  }
  if (!posted && !range) return null;
  const scope = stats && isObj(stats.scope) ? stats.scope : {};
  const location = [str(scope.city), str(scope.country)].filter(Boolean).join(', ') || null;
  return { title: str(scope.title), location, posted, range };
}

// ── applications ─────────────────────────────────────────────────────────

export const FOLLOW_UP_REASONS = ['no_reply_10d', 'follow_up_due', 'interview_tomorrow', 'deadline_soon'] as const;
export type FollowUpReasonKind = (typeof FOLLOW_UP_REASONS)[number];
export interface ApplicationsData {
  counts: Array<{ status: string; count: number }>;
  /** Tracker `FollowUpView`s: a fact (`reason`, `at`, `days`) about one application entry. */
  followUps: Array<{ entryId: string; reason: FollowUpReasonKind; title: string | null; company: string | null; at: string | null; days: number | null }>;
}

/** Where a follow-up opens: that application's details on /applications (`?entry=<entryId>`). Pure. */
export function followUpHref(entryId: string): string {
  return `/applications?entry=${encodeURIComponent(entryId)}`;
}
/** `TrackerSummary { byStatus: Record<status, n>, followUps: FollowUpView[] }` from application_summary. Pure. */
export function parseApplications(d: unknown): ApplicationsData | null {
  if (!isObj(d)) return null;
  const counts: ApplicationsData['counts'] = [];
  for (const [status, n] of Object.entries(isObj(d.byStatus) ? d.byStatus : {})) {
    const count = num(n);
    if (str(status) && count !== null && count > 0) counts.push({ status, count });
  }
  const followUps: ApplicationsData['followUps'] = [];
  for (const f of Array.isArray(d.followUps) ? d.followUps.slice(0, 8) : []) {
    if (!isObj(f) || !str(f.entryId) || !(FOLLOW_UP_REASONS as readonly string[]).includes(f.reason as string)) continue;
    followUps.push({ entryId: f.entryId as string, reason: f.reason as FollowUpReasonKind, title: str(f.title), company: str(f.companyName), at: str(f.at), days: num(f.days) });
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
  /** The server says the `copilot_memory` consent is missing (GoApply): ask it before saving. */
  consentRequired: boolean;
}
export function parseMemoryAdd(d: unknown): MemoryAddData | null {
  if (!isObj(d) || !str(d.proposalId) || !str(d.fact)) return null;
  return {
    proposalId: d.proposalId as string,
    fact: (d.fact as string).slice(0, 500),
    expiresAt: str(d.expiresAt),
    status: statusOf(d.status),
    consentRequired: d.consentRequired === true,
  };
}

/** The reason a 403 on a memory proposal names when the consent is missing (server COPILOT_ERROR_CODES). */
export const MEMORY_CONSENT_REASON = 'copilot_memory_consent_required';

// ── profile_gaps ─────────────────────────────────────────────────────────

export interface ProfileGapsData {
  /** Profile completeness rule keys (`profile.missing.<key>` labels). */
  gaps: Array<{ key: string }>;
  href: string;
}
/** `{ completeness, missing: [{ key, label, section }], href }` from get_profile_gaps. Pure. */
export function parseProfileGaps(d: unknown): ProfileGapsData | null {
  if (!isObj(d) || !Array.isArray(d.missing)) return null;
  const gaps: ProfileGapsData['gaps'] = [];
  for (const g of d.missing.slice(0, 10)) {
    const key = isObj(g) ? str(g.key) : str(g);
    if (key && !gaps.some((x) => x.key === key)) gaps.push({ key });
  }
  return gaps.length ? { gaps, href: safeAppPath(d.href) ?? '/profile' } : null;
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
  items: Array<{ company: string; programme: string | null; closesAt: string | null; officialUrl: string; sourceName: string | null; needsReverify: boolean }>;
}
/** `CampusDeadlinesCardData` (server contract) from campus_deadlines. Pure. */
export function parseCampusDeadlines(d: unknown): CampusDeadlinesData | null {
  if (!isObj(d) || !Array.isArray(d.items)) return null;
  const items: CampusDeadlinesData['items'] = [];
  for (const i of d.items.slice(0, 10)) {
    if (!isObj(i)) continue;
    const company = str(i.company);
    const officialUrl = safeExternalUrl(i.officialUrl);
    // The official link is required (CN plan: official-link-only listings).
    if (!company || !officialUrl) continue;
    items.push({ company, programme: str(i.programme), closesAt: str(i.closesAt), officialUrl, sourceName: str(i.sourceName), needsReverify: i.needsReverify === true });
  }
  return items.length ? { items } : null;
}

// ── resume_tips / rewrite_ready (WP-50 card types; added at the Wave 4 gate) ──

export interface ResumeTipsData {
  href: string;
  stale: boolean;
  /** `type` + `params` give the localized `resumeCheck.issue.<type>.*`; `why`/`how` are the English fallback. */
  issues: Array<{ id: string; type: string; params?: Record<string, string | number>; why: string; how: string; section: string | null }>;
}
const isParams = (v: unknown): v is Record<string, string | number> =>
  isObj(v) && Object.values(v).every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)));
/** `ResumeTipsCardData` (server contract) from the resume_issues tool. Pure. */
export function parseResumeTips(d: unknown): ResumeTipsData | null {
  if (!isObj(d) || !str(d.resumeId) || !Array.isArray(d.issues)) return null;
  const href = safeAppPath(d.href) ?? `/resume/${encodeURIComponent(d.resumeId as string)}/check`;
  const issues: ResumeTipsData['issues'] = [];
  for (const i of d.issues.slice(0, 12)) {
    if (!isObj(i) || !str(i.id) || !str(i.why)) continue;
    issues.push({
      id: i.id as string,
      type: str(i.type) ?? 'unknown',
      ...(isParams(i.params) ? { params: i.params } : {}),
      why: str(i.why)!,
      how: str(i.how) ?? '',
      section: str(i.section),
    });
  }
  return { href, stale: d.stale === true, issues };
}

export interface RewriteReadyData {
  href: string;
  suggestions: string[];
  blocked: number;
}
/** `{ resumeId, issueId, suggestions: [{ text }], blocked, href, aiWritten }` after a confirmed rewrite. Pure. */
export function parseRewriteReady(d: unknown): RewriteReadyData | null {
  if (!isObj(d) || !str(d.resumeId) || !str(d.issueId)) return null;
  const href =
    safeAppPath(d.href) ?? `/resume/${encodeURIComponent(d.resumeId as string)}/check?issue=${encodeURIComponent(d.issueId as string)}`;
  const suggestions = Array.isArray(d.suggestions)
    ? d.suggestions
        .map((s) => (isObj(s) ? str(s.text) : str(s)))
        .filter((s): s is string => !!s)
        .slice(0, 5)
    : [];
  return { href, suggestions, blocked: Math.max(0, num(d.blocked) ?? 0) };
}
