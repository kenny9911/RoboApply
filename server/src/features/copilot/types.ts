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
import type { JobDetailResponse } from '../jobs/detail/index.js';
import type { CompanyProfile } from '../jobs/companies/index.js';
import type { MatchFitView } from '../match/index.js';
import type { ConnectionsForJobResponse, OutreachChannel, OutreachDraftView } from '../network/index.js';
import type { QuestionView } from '../prep/index.js';
import type { TrackerSummary } from '../tracker/index.js';
import type { CampusEventView } from '../cn/campus/index.js';
import type { FixIssueResponse, LatestGradeResponse, TailorSessionView } from '../resume/index.js';
import type { CoverLetterView, LetterLength, LetterTone } from '../coverletter/index.js';
import type { ImportJobResponse, ManualJob } from '../jobs/import/index.js';
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
  scoreJob(userId: string, jobId: string, options: { resumeVariantId?: string | null; locale?: string }): Promise<MatchFitView>;
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
}

export interface ToolOutput {
  /** What the model sees (wrapped in <data> and truncated). */
  data: unknown;
  cards?: CopilotCard[];
  /** Job ids this result returned (they may then appear in cards and links). */
  jobIds?: string[];
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
