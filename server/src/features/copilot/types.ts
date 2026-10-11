// server/src/features/copilot/types.ts — internal types of the Assistant (WP-50).
//
// `CopilotAreas` is the narrow adapter the tools and proposals call. Every
// method goes to another area's public surface (`features/<area>/index.ts`)
// in `areas.ts`; tests pass fakes. Nothing here writes to another area's
// tables directly: writes happen only inside the area services, and only
// when the user applies a proposal.

import type { z } from 'zod';
import type { BrandId, Market, ProductBrand } from '../../platform/brand/registry.js';
import type { FlagKey } from '../../platform/flags.js';
import type { FeedCountResult, FeedItem, FeedSort, PublicFeedItem } from '../feed/index.js';
import type { FilterSet, SearchProfileWire } from '../search/index.js';
import type { JobDetailResponse, SimilarJobItem } from '../jobs/detail/index.js';
import type { CompanyProfile } from '../jobs/companies/index.js';
import type { MatchFitView } from '../match/index.js';
import type { ConnectionsForJobResponse, OutreachChannel, OutreachDraftView } from '../network/index.js';
import type { QuestionView } from '../prep/index.js';
import type { TrackerSummary } from '../tracker/index.js';
import type { CampusEventView } from '../cn/campus/index.js';
import type { FixIssueResponse, LatestGradeResponse, TailorSessionView } from '../resume/index.js';
import type { CoverLetterView, LetterLength, LetterTone } from '../coverletter/index.js';
import type { AddedJobItem, ImportJobResponse, ManualJob } from '../jobs/import/index.js';
import type { CopilotCard, CopilotToolName, ProposalKind } from './contract.js';
import type { SalaryStatsInput, SalaryStatsResult } from '../feed/index.js';

/** The other areas, as the Assistant uses them (all reads, except the proposal applies). */
export interface CopilotAreas {
  // feed / search
  feedPreview(userId: string, input: { q?: string; filters?: Partial<FilterSet>; sort?: FeedSort; limit: number }): Promise<FeedItem[]>;
  feedPublicList(input: { role?: string; city?: string; country?: string; limit: number }): Promise<PublicFeedItem[]>;
  countForFilters(userId: string, filters: FilterSet): Promise<FeedCountResult>;
  activeSearchProfile(userId: string): Promise<SearchProfileWire>;
  searchProfile(userId: string, id: string): Promise<SearchProfileWire>;
  /** Applying a filter proposal: optimistic `version` (VersionConflictError on mismatch). */
  patchFilters(userId: string, searchProfileId: string, version: number, patch: Record<string, unknown>): Promise<SearchProfileWire>;
  // jobs
  getJob(userId: string, jobId: string): Promise<JobDetailResponse>;
  /** THE fit of a job for the person's main resume (match/fit.ts `getFit`); the free on-demand score may run. Never a resume version. */
  fit(userId: string, jobId: string, options: { locale?: string }): Promise<MatchFitView>;
  /** The separately named measure "With this version" (`getVariantFit`): only for the user's explicit question about one resume version. */
  variantFit(userId: string, jobId: string, variantId: string, options: { locale?: string }): Promise<MatchFitView>;
  /**
   * The stored fit for ONE job (the last AI read, else the quick estimate). Never a model call, never a credit,
   * never a resume version. No tool calls it since MKT-4H (lists read `fits`): it stays for the harness seam
   * `assistant_stored_fit` (match/eval/seamRegistry.ts), and tools.test.ts holds it equal to `fits`.
   */
  storedFit(userId: string, jobId: string, options: { locale?: string }): Promise<MatchFitView>;
  /**
   * THE fit of each job of a list, for the person's main resume, in ONE batch
   * read of the fit contract (never a model call, never a credit). A job with
   * no fit has no entry; on GoApply without a live 个性化推荐 grant nobody's
   * fit is read, so the answer is empty (the feed's own rule).
   */
  fits(userId: string, jobIds: readonly string[], options: { locale?: string }): Promise<Map<string, MatchFitView>>;
  /**
   * Open jobs like one job. `by: 'similar'` = the job page's own Similar jobs
   * list (by job vector, best fit first); `by: 'title'` = a search by the
   * job's title through the feed, for as long as the job-detail surface does
   * not offer its list. The job itself is never among them.
   */
  similarJobs(userId: string, jobId: string): Promise<{ items: Array<FeedItem | SimilarJobItem>; by: 'similar' | 'title' }>;
  /** Jobs the user added themselves ("Added by you": private, owned by them), newest first. */
  addedJobs(userId: string, options: { limit: number }): Promise<AddedJobItem[]>;
  companyProfile(idOrSlug: string): Promise<CompanyProfile>;
  connectionsForJob(userId: string, jobId: string): Promise<ConnectionsForJobResponse>;
  /**
   * Questions for a job. Read-only by default; `write: true` (the user asked
   * for questions) lets prep write a missing AI practice set for the job.
   */
  planForJob(userId: string, jobId: string, options?: { write?: boolean; locale?: string }): Promise<{ questions: QuestionView[] }>;
  // you
  trackerSummary(userId: string): Promise<TrackerSummary>;
  profileCompleteness(userId: string): Promise<{ completeness: number; missing: Array<{ key: string; label: string }> }>;
  profileSnapshot(userId: string): Promise<string | null>;
  primaryResumeId(userId: string): Promise<string | null>;
  resumeLatestGrade(userId: string, resumeId: string): Promise<LatestGradeResponse>;
  campusUpcoming(userId: string, options: { limit: number }): Promise<CampusEventView[]>;
  salaryStats(input: SalaryStatsInput): Promise<SalaryStatsResult>;
  /** GoApply mode `off` hides third-party postings (R-14); RoboApply: always true. */
  postingsAllowed(market: Market): boolean;
  // proposal applies (each spends its own credit inside the area service)
  createTailorSession(userId: string, input: { baseVariantId: string; jobId: string; idempotencyKey: string; locale?: string }): Promise<TailorSessionView>;
  createCoverLetter(userId: string, input: { jobId: string; resumeVariantId: string; tone?: LetterTone; length?: LetterLength }, idempotencyKey: string): Promise<CoverLetterView>;
  /** NET `networkService.createOutreachDraft`: AI gate, then one `outreach` credit, then the draft. Never sends. */
  createOutreachDraft(userId: string, body: { jobId: string; channel: OutreachChannel; locale?: string }, idempotencyKey: string): Promise<OutreachDraftView>;
  importJob(userId: string, body: { url: string }, idempotencyKey: string): Promise<ImportJobResponse>;
  saveImportedJob(userId: string, fields: ManualJob, options: { importId: string; idempotencyKey: string }): Promise<ImportJobResponse>;
  fixResumeIssue(
    userId: string,
    resumeId: string,
    issueId: string,
    input: { variant: 'ai' | 'longer' | 'shorter' | 'stronger'; instruction?: string; idempotencyKey: string; locale?: string },
  ): Promise<FixIssueResponse>;
}

export interface ProposalDraft {
  kind: ProposalKind;
  payload: Record<string, unknown>;
}

/** One job as a `job_list` card row carries it: a feed item, a similar-jobs item, or one of the user's own added jobs. */
export type JobListItem = { jobId: string } & Record<string, unknown>;

/** A row `show_jobs` may put on the card. */
export interface ListedJob {
  item: JobListItem;
  /**
   * True for a row a tool returned in THIS turn. False for a row of a job
   * list in one of the thread's recent answers: its fit is from then, so it
   * is read again before the row is shown.
   */
  fromThisTurn: boolean;
}

/** What a tool run knows about the turn. */
export interface ToolContext {
  userId: string | null;
  brand: ProductBrand;
  market: Market;
  locale: string;
  now: Date;
  /** The assistant message the cards belong to. */
  messageId: string;
  contextJobId: string | null;
  resumeId: string | null;
  /** 'seeker' (signed in) or 'public' (visitor turn: no user, no proposals). */
  scope: 'seeker' | 'public';
  areas: CopilotAreas;
  isEnabled(key: FlagKey): Promise<boolean>;
  hiringContactsMode(): 'off' | 'deeplinks_only' | 'on';
  /** Create a pending proposal (seeker scope only) and return its id and expiry. */
  propose(draft: ProposalDraft): Promise<{ id: string; expiresAt: Date }>;
  /** Credits left in a bucket's window (window + grants); null when unknown. */
  creditsLeft(bucket: string): Promise<{ remaining: number; resetsAt: string } | null>;
  /** Does the user have a live consent of this type? (GoApply memory) */
  hasConsent(type: 'copilot_memory'): Promise<boolean>;
  newCardId(): string;
  /** Page context of a visitor turn. */
  page?: { path: string; role?: string; city?: string; country?: string };
  /**
   * The rows the job tools returned earlier in this turn (and the rows of the
   * job lists in the thread's recent answers), by job id. `show_jobs` builds
   * its card from them: no new query. Absent outside a turn's tool loop.
   */
  listedJobs?: ReadonlyMap<string, ListedJob>;
  /**
   * True while the tools of the answer's last tool round run: the model
   * writes its reply next and can call no tool again, so a list returned now
   * cannot be cited with show_jobs. The service shows such a list whole, and
   * the list tool tells the model so instead of asking for a call it cannot make.
   */
  lastToolRound?: boolean;
}

export interface ToolOutput {
  /** What the model sees (wrapped in <data> and truncated). */
  data: unknown;
  cards?: CopilotCard[];
  /** Job ids this result returned (they may then appear in cards and links). */
  jobIds?: string[];
  /**
   * Set by the job-list tools (SM-9: the card shows exactly the jobs the
   * answer cites).
   *   'candidates'  a list for the model to choose from (search_jobs,
   *                 top_fit_jobs, added_jobs, similar_jobs). Its `cards` are
   *                 the whole list and are NOT shown when the tool returns:
   *                 the service keeps their rows for `show_jobs` and shows
   *                 the whole list only if the turn ends with no show_jobs
   *                 call after it.
   *   'cited'       the list the answer talks about (show_jobs). Its card is
   *                 shown at once, and the lists held back SO FAR are
   *                 dropped (a list returned later is held again).
   * Absent: cards are shown as they come (every other tool, visitor search).
   */
  list?: 'candidates' | 'cited';
}

export interface CopilotTool<A = Record<string, unknown>> {
  name: CopilotToolName;
  description: string;
  schema: z.ZodType<A>;
  /** Visitor turns only get tools marked public. */
  public?: boolean;
  /** Seeker-only availability (flags, market, consent). Default: available. */
  available?(ctx: ToolContext): boolean | Promise<boolean>;
  run(args: A, ctx: ToolContext): Promise<ToolOutput>;
}

export type { BrandId };
