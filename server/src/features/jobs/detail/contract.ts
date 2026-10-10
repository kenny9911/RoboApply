// server/src/features/jobs/detail/contract.ts
//
// Job detail, save, apply click, share, similar jobs, company news
// (ARCHITECTURE.md §3.4; PRODUCT_PLAN.md F-JOB-01…08, F-NET-02/03, F-TRK-03;
// TASK_PLAN.md WP-34). Mount: /api/v1/roboapply/jobs (replaces /v2/jobs/:id).
// `POST /jobs/:id/score` is MATCH's handler (`createScoreJobHandler()`,
// WP-18), mounted on this router.
//
// Rules:
//   - a job whose market differs from the brand's answers 404; a private
//     (imported) job is visible only to its owner (404 for everyone else);
//   - `apply-click` moves the tracker entry to `applied` at once and the UI
//     shows an inline Undo (rulings R1/C11; D1: we never submit anything);
//     it is idempotent, and `DELETE /applied` undoes it;
//   - D3: every company fact is sourced; unknown renders "Not listed"; pay
//     that the posting does not state is `null` ("Pay not listed", never 0);
//     sponsorship and requirement lines are verbatim quotes from the post;
//     the AI summary is labelled as AI; company news is labelled "Search
//     results, not verified by %BRAND%";
//   - source and apply contract (GOAPPLY_PARITY_PLAN §5, the same fields as the
//     feed card; rules in feed/sourceLine.ts): `job.apply { url, target }`,
//     `job.source { …, original, url, lastVerifiedAt, via }` and `job.salary`
//     (null when the posting states no pay). D1: `apply.url` is a link the
//     user opens; nothing is submitted for them.

import { z } from 'zod';
import type { Sourced } from '../../../platform/http.js';
import type { HiringContactsMode } from '../../../platform/brand/registry.js';
import type { CompanyProfile } from '../companies/contract.js';
import type { ApplyLink, FeedItem, SalaryLine, SourceFacts } from '../../feed/contract.js';
import { ScoreJobBodySchema as MatchScoreJobBodySchema, type FitTierKey, type MatchDimension, type MatchFitView } from '../../match/contract.js';
import type { MatchExplanation } from '../../compliance/contract.js';

const Id = z.string().min(1).max(64);
export const JobIdParamsSchema = z.object({ id: Id });

/** Field provenance (ARCH §2.14). Kept for older imports; prefer `Sourced<T>` from platform/http. */
export interface SourcedValue<T> {
  value: T;
  source: string;
  sampleSize?: number;
  asOf: string;
  method?: 'stated' | 'computed' | 'ai_estimate';
  url?: string;
}

/** Verbatim posting sections, in this order. The UI localizes the heading by kind. */
export const JOB_SECTION_KINDS = ['responsibilities', 'qualifications', 'benefits', 'description'] as const;
export type JobSectionKind = (typeof JOB_SECTION_KINDS)[number];

/** Requirement lines quoted from the posting (WP-17 `marketTags`, REQUIREMENT_TAGS). */
export const JOB_REQUIREMENT_TAGS = ['citizenship_required', 'citizenship_not_required', 'clearance_required', 'clearance_not_required'] as const;
export type JobRequirementTag = (typeof JOB_REQUIREMENT_TAGS)[number];

/** Statuses before the user applied (anything else counts as applied or later). */
export const PRE_APPLY_STATUSES = ['bookmarked', 'applying'] as const;

export interface JobPay {
  min: number | null;
  max: number | null;
  currency: string;
  period: 'year' | 'month' | 'week' | 'day' | 'hour';
  /** The posting's own pay text (e.g. "15-25K·13薪"), shown verbatim when present. */
  text: string | null;
}

export interface JobDetail {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  workModel: 'remote' | 'hybrid' | 'onsite' | null;
  employmentType: string | null;
  seniority: string | null;
  /** Null = "Pay not listed" (never 0). */
  pay: JobPay | null;
  /** The posting states pay in words only (e.g. 面議); shown verbatim, never as a number. */
  payText: string | null;
  /** AI summary: labelled "Summary written by AI from the job post" (`aiWritten: true`). */
  summary: { text: string; aiWritten: true } | null;
  /** Verbatim sections from the posting. */
  sections: Array<{ kind: JobSectionKind; body: string }>;
  skills: Array<{ skill: string; kind: 'hard' | 'soft'; required: boolean }>;
  /** `quote` is the posting's own words; without a quote the status is 'not_stated' (ruling C18). */
  sponsorship: { status: 'offered' | 'not_offered' | 'not_stated'; quote: string | null };
  /** Citizenship / clearance lines, each with the posting's own words. */
  requirements: Array<{ tag: JobRequirementTag; quote: string }>;
  applyUrl: string | null;
  /**
   * The posting's own apply link with where it leads: 'gohire' (the GoHire
   * posting page, a GoHire bank row), 'employer' (the employer's careers site
   * or ATS page, an employer-board row) or null (not known: a user's own
   * import, an aggregator's link). Null when there is no usable link. `url`
   * equals `applyUrl` whenever that is an http(s) link. Always sent.
   */
  apply?: ApplyLink | null;
  /**
   * Pay as the posting states it (`text` is the line as posted where there is
   * one); null when the posting states no pay ("薪资未披露" / "Pay not
   * listed"; never 面议). Agrees with `pay` / `payText`, which stay. Always sent.
   */
  salary?: SalaryLine | null;
  postedAt: string | null;
  /** True when the posting date is our first-seen date, not the employer's. */
  postedAtEstimated: boolean;
  /** "Last checked {date}". */
  lastSeenAt: string | null;
  closedAt: string | null;
  /** 'closed' = no longer listed (expired, removed or archived). */
  status: 'open' | 'closed';
  /**
   * Where we got the posting; `kind` drives the source line. `original` (the
   * original publisher: the employer for an employer-board row), `url` (the
   * original posting link), `lastVerifiedAt` (when we last saw it live) and
   * `via` ('bank' | 'ats' | 'import'; absent for an aggregator row) are the
   * facts every mainland posting shows (来源 / 原始链接 / 最后核验); always sent.
   */
  source: { name: string; kind: FeedItem['source']['kind']; originalName: string | null } & Partial<SourceFacts>;
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  isAgency: boolean;
  visibility: 'public' | 'private';
  /** At most 3, from real fields only (same rules as the feed card). */
  badges: FeedItem['badges'];
  /** GoApply: the employer's campus programme (官方网申 window and 届别), from a staff-verified record. */
  campus?: JobCampusInfo | null;
}

export interface JobCampusInfo {
  /** Programme title, e.g. "2027届校园招聘". */
  title: string;
  /** e.g. "2027届". */
  graduationClass: string;
  classYears: number[];
  applyOpensAt: string | null;
  applyClosesAt: string | null;
  /** The employer's official page (always linked; D3). */
  officialUrl: string;
  verifiedAt: string | null;
  /** Not re-verified in 14 days: renders "待核实". */
  needsCheck: boolean;
}

/** The company block of a job (only sourced facts; D3). */
export interface CompanySummary {
  id: string | null;
  name: string;
  slug: string | null;
  logoUrl: string | null;
  domain: string | null;
  /** Only fields with provenance; unknown fields are absent ("Not listed"). */
  facts: CompanyProfile['facts'];
  /** "{n} open jobs at {company} in %BRAND%" — public rows only; null when the job has no company record. */
  openJobs: Sourced<number> | null;
}

/** Dimension evidence (scorer v3). */
export type FitDimension = MatchDimension;

/** The fit carried by `GET /jobs/:id`: MATCH's view from the cache (never a model call). */
export type FitView = MatchFitView;

export interface JobTrackerState {
  id: string;
  status: string;
  dateApplied: string | null;
}

/** "Get ready for this job" (ruling C43): Saved → Resume tailored → Practiced → Applied. */
export interface JobChecklist {
  saved: boolean;
  /** A resume tailored for this job (newest), if any. */
  tailoredResumeId: string | null;
  coverLetterId: string | null;
  /** Null = we cannot tell yet (practice sessions are not linked to jobs: SR-34-1). */
  practiced: boolean | null;
  applied: boolean;
}

/** A LinkedIn people search the user opens themselves (F-NET-02/03; no data is fetched). */
export interface PeopleSearchLink {
  kind: 'role' | 'past_companies' | 'schools';
  /** Null when the profile has nothing to search with (e.g. no schools): the UI explains what to add. */
  url: string | null;
  /** ICU params for the label. */
  params: { company: string; title?: string; companies?: string; schools?: string };
}

export interface JobPeople {
  mode: HiringContactsMode;
  /** Empty on GoApply (LinkedIn search links are an international feature). */
  searchLinks: PeopleSearchLink[];
}

/** GET /jobs/:id */
export interface JobDetailResponse {
  job: JobDetail;
  company: CompanySummary;
  /** Cached fit or the quick estimate (no model call); null when nothing could be scored. */
  fit: FitView | null;
  /** "Why this job" lines (PIPL Art. 24) for the fit above; null without a fit. */
  explanation: MatchExplanation | null;
  tracker: JobTrackerState | null;
  checklist: JobChecklist;
  similarIds: string[];
  autofill: { supported: boolean; atsType: string | null };
  people: JobPeople;
  /** `marketHooks.cardMeta` output for `MarketJobMeta` (CN/TW). */
  marketMeta: Record<string, Record<string, unknown>>;
}

/** POST /jobs/:id/score (MATCH's handler; platform-paid; 80/day/user, beyond it the pre-score). */
export const ScoreJobBodySchema = MatchScoreJobBodySchema;
export interface ScoreJobResponse {
  fit: MatchFitView;
}

/**
 * A similar job: the feed card shape, except `pay` keeps every period the
 * posting states (weekly pay included; FeedItem has no 'week'), and
 * `payText` carries pay stated in words only. Never "Pay not listed" for a
 * job whose post states pay (D3).
 */
export interface SimilarJobItem extends Omit<FeedItem, 'pay'> {
  pay: JobPay | null;
  payText: string | null;
}

/**
 * GET /jobs/:id/similar — same role family and country, excluding hidden and
 * flagged jobs; best fit first. Empty while `jobs.recommendations` is off
 * (GoApply with CN_RECRUITMENT_INFO_MODE=off; on by default). On GoApply a
 * public posting with no usable apply link is never listed.
 */
export interface SimilarJobsResponse {
  items: SimilarJobItem[];
}

/** POST|DELETE /jobs/:id/save */
export interface SaveJobResponse {
  tracker: JobTrackerState | null;
}

/**
 * POST /jobs/:id/apply-click. 409 `job_closed` for a closed job and 409
 * `no_apply_link` when the job has no employer link (use "I applied" then).
 */
export interface ApplyClickResponse {
  applyUrl: string | null;
  atsType: string | null;
  extensionSupported: boolean;
  /** The tracker entry moved to applied (undo with DELETE /jobs/:id/applied). */
  trackerEntryId: string;
  /**
   * True when nothing changed: the job was already Applied or at a later
   * stage. Callers offer "Undo · I didn't apply" only when this is false.
   * Every apply response carries it.
   */
  alreadyApplied: boolean;
}

/** POST /jobs/:id/applied — mark applied manually ("I applied"). */
export const MarkAppliedBodySchema = z.object({ appliedAt: z.iso.datetime().optional() }).strict();
export interface MarkAppliedResponse {
  tracker: JobTrackerState;
  /** True when nothing changed (already Applied or later): offer no Undo. Every apply response carries it. */
  alreadyApplied: boolean;
}

/**
 * DELETE /jobs/:id/applied — "Undo · I didn't apply". Reverts a recent
 * (UNDO_APPLIED_WINDOW_MS, 24 h) move to Applied that one of the apply
 * actions made, whichever surface it came from (`UNDOABLE_APPLY_VIA`: the
 * apply click, "I applied", opening a Ready to apply kit, the extension's
 * "I submitted"). Anything else (an older application, a stage change made
 * by hand in the tracker) is left as it is and answered unchanged.
 */
export interface UndoAppliedResponse {
  tracker: JobTrackerState | null;
}

/** POST /jobs/:id/share → public URL only when `publicDisplay`, else an app link. */
export interface ShareResponse {
  url: string;
  public: boolean;
}

/** GET /jobs/:id/company-news (V2; dark until the `companyNews` flag exists and is on, and Tavily is configured). */
export interface CompanyNewsItem {
  title: string;
  url: string;
  /** The publisher's host (e.g. "reuters.com"). */
  publisher: string;
  /** Null when the search result has no date. */
  publishedAt: string | null;
}
export interface CompanyNewsResponse {
  items: CompanyNewsItem[];
  /** Always 'search_results': rendered "Search results, not verified by %BRAND%". */
  kind: 'search_results';
  fetchedAt: string;
}

export const JOB_DETAIL_ERROR_CODES = {
  notFound: 'job_not_found',
  closed: 'job_closed',
  inTracker: 'job_in_progress',
  noApplyLink: 'no_apply_link',
} as const;

/** How long after the move to Applied "Undo · I didn't apply" still reverts it. */
export const UNDO_APPLIED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `payload.via` of a move to Applied that "Undo · I didn't apply" may revert (the tracker's `ApplyVia`). */
export const UNDOABLE_APPLY_VIA = ['apply_click', 'manual', 'agent_open', 'extension'] as const;

/** Tier word for a fit (re-exported for the UI). */
export type { FitTierKey };
