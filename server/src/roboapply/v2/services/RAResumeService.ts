// server/src/roboapply/v2/services/RAResumeService.ts
//
// Resume variant CRUD for the hub and the editor.
//
//   create(base | from_template)   a blank or template resume (takes a base slot)
//   uploadAndCreate / importFromLinkedIn
//                                  a parsed file → a base resume (10 files a day
//                                  per user; the GoHire parse service only when
//                                  the brand and the user's consent allow it)
//   createTailoredForJob           the legacy `POST /resumes kind=tailored_for_jd`:
//                                  runs a tailor session (features/resume/tailor),
//                                  so it spends one `tailor` credit, runs the
//                                  claim check and stores `unverifiedClaims`
//   list / getById / patch / delete / setPrimary / patchLayout / exportVariant
//
// A tailored version is only ever written by a tailor session. The old
// tailor-diff / tailor-apply pair (a free second path with no claim check) is
// retired: its routes answer 410.

import crypto from 'crypto';
import prisma from '../../../lib/prisma.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import {
  ingestCandidateResume,
  CandidateResumeIngestError,
  type CandidateResumeIngestResult,
} from '../../../lib/candidateResumeIngest.js';
import { NotImplementedError } from '../../../platform/http.js';
import { getCurrentBrandOrDefault } from '../../../platform/brand/brandContext.js';
import { aiAllowed, hasLiveConsent } from '../../../platform/consent/index.js';
import { DAY, consumeRateLimit, rateLimitKey } from '../../../platform/ratelimit/index.js';
import { goHireParseActive } from '../../../platform/residency/index.js';
import type { ImplicitAiLabel } from '../../../features/compliance/index.js';
import {
  buildExportFileName,
  defaultPageFor,
  renderResumeDocx,
  renderResumePdf,
  type FileNameStyleKey,
  type PageSize,
} from '../lib/resumeExport.js';
import { LEGACY_JOB_SCOPE_SELECT, legacyJobVisible, loadLegacyVisibleJob } from '../lib/legacyJobScope.js';

export type RAResumeKind = 'base' | 'tailored_for_jd' | 'from_template';

export interface RAResumeVariantView {
  id: string;
  userId: string;
  name: string;
  kind: RAResumeKind;
  targetJobId: string | null;
  basedOnVariantId: string | null;
  templateKey: string | null;
  resumeMarkdown: string;
  resumeContentHash: string;
  matchScoreCached: number | null;
  isPrimary: boolean;
  sourceKind: string | null;
  parseStatus: string | null;
  summary: string | null;
  highlight: string | null;
  originalFileName: string | null;
  hasOriginalFile: boolean;
  lastEditedAt: string;
  createdAt: string;
  deletedAt: string | null;
  // ── WP-36b (additive) ──
  /** `RAResumeVariant.layout` (template, page, spacing, accent, date format), or null. */
  layout: Record<string, unknown> | null;
  /** The job title this resume is aimed at (hub), or null. */
  targetTitle: string | null;
  /** Inserted claims the user has not verified; >0 blocks export (ruling C12). */
  unverifiedClaims: number;
  /** True when AI wrote part of this resume (tailored, or AI text applied). */
  aiAssisted: boolean;
}

export interface RAResumeVariantSummary {
  id: string;
  name: string;
  kind: RAResumeKind;
  targetJobId: string | null;
  targetJobTitle: string | null;
  targetJobCompany: string | null;
  matchScoreCached: number | null;
  isPrimary: boolean;
  sourceKind: string | null;
  lastEditedAt: string;
  createdAt: string;
  // ── WP-36b (additive) ──
  targetTitle: string | null;
  /** The base resume a tailored version was made from. */
  basedOnVariantId: string | null;
  unverifiedClaims: number;
  /** The tailor session in review that made this version, while details are unverified; else null. */
  tailorSessionId: string | null;
}

export type ResumeCreateInput =
  | { kind: 'base'; name: string; resumeMarkdown: string }
  | { kind: 'from_template'; name: string; templateKey: string };

/** The legacy `POST /resumes` body for a tailored version (now a tailor session). */
export interface TailoredCreateInput {
  name?: string;
  basedOnVariantId: string;
  targetJobId: string;
}

export interface TailoredCreateResult {
  resume: RAResumeVariantView;
  /** The tailor session that made it (`/resume?tailorSession=<id>` opens Verify details). */
  tailorSessionId: string;
  /** Details still to verify; export is blocked while > 0 (ruling C12). */
  pendingClaims: number;
}

export interface ResumePatchInput {
  name?: string;
  resumeMarkdown?: string;
  /** Hub "target title"; an empty string clears it. */
  targetTitle?: string | null;
  /** The editor saved AI-written text: stamps `RAResumeVariant.aiAssistedAt` once. */
  aiAssisted?: boolean;
}

/** Base resumes per user (Free and Pro); tailored versions do not count (PRODUCT_PLAN.md F-RES-02). */
export const BASE_RESUME_LIMIT = 5;
/** Variant kinds that take one of the base slots. */
export const BASE_SLOT_KINDS: RAResumeKind[] = ['base', 'from_template'];

/** The user already has BASE_RESUME_LIMIT base resumes (route → 409 resume_limit_reached). */
export class ResumeLimitError extends Error {
  readonly code = 'resume_limit_reached' as const;
  readonly limit = BASE_RESUME_LIMIT;
  constructor() {
    super(`You can keep up to ${BASE_RESUME_LIMIT} resumes.`);
    this.name = 'ResumeLimitError';
  }
}

/** Export refused while inserted claims are unverified (route → 409 unverified_claims). */
export class UnverifiedClaimsError extends Error {
  readonly code = 'unverified_claims' as const;
  constructor(readonly count: number) {
    super('Some inserted details are not verified yet.');
    this.name = 'UnverifiedClaimsError';
  }
}

/** The tracker entry named for the file record is not the user's (route → 404). */
export class TrackerEntryNotFoundError extends Error {
  readonly code = 'tracker_entry_not_found' as const;
  constructor() {
    super('Application not found');
    this.name = 'TrackerEntryNotFoundError';
  }
}

/**
 * Strip the "Page N of M" footers a LinkedIn "Save to PDF" export stamps on
 * each page, and the blank runs its sidebar leaves behind.
 */
export function cleanProfileExportText(text: string): string {
  if (!text || typeof text !== 'string') return text ?? '';
  return text
    .split('\n')
    .filter((line) => !/^page\s+\d+\s+of\s+\d+$/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Template keys `PATCH /:id/layout` accepts (the contract's RESUME_TEMPLATES). */
const LAYOUT_KEYS = [
  'template', 'font', 'sizes', 'page', 'spacing', 'justify', 'headerAlign', 'accent',
  'bullet', 'skillsLayout', 'eduOrder', 'dateFormat', 'hideDivider',
] as const;

/**
 * Provenance of a tailored version, recorded where its text is produced:
 * `tailored` = the tailor agent (a model) wrote it; `tailored_copy` = a plain
 * copy of the base resume made without AI (no AI consent, or the agent
 * failed). Only the first counts as AI-written.
 */
export const TAILORED_AI_SOURCE = 'tailored';
export const TAILORED_COPY_SOURCE = 'tailored_copy';

/**
 * Whether AI wrote part of a variant: a tailored version the tailor agent
 * wrote (`sourceKind: 'tailored'`), or any variant once AI text was applied to
 * it (`RAResumeVariant.aiAssistedAt`). `kind` alone never decides it: a
 * tailored copy made without AI is not AI content.
 */
export function isAiAssisted(row: { kind?: string | null; sourceKind?: string | null; aiAssistedAt?: Date | string | null }): boolean {
  return row.sourceKind === TAILORED_AI_SOURCE || Boolean(row.aiAssistedAt);
}

export type ExportFormat = 'pdf' | 'docx';

export interface ExportRequest {
  format: ExportFormat;
  nameStyle?: FileNameStyleKey | null;
  /** Record the exact file on this application (RAApplicationArtifact). */
  trackerEntryId?: string | null;
  /**
   * With no `trackerEntryId`: record the file on the user's own application
   * for the job this version was tailored for, when there is one (a download
   * from the editor or the hub names no application; WP-95).
   */
  autoTrack?: boolean;
  /**
   * The file carries a photo from the user's device. A photo is never stored
   * on our servers, so an application found by `autoTrack` then records the
   * file's name and sha256 without keeping a copy. (A named `trackerEntryId`
   * is made without the photo by the route.)
   */
  photoInFile?: boolean;
  /** 'download' (hub/editor) | 'agent' | 'extension'. */
  channel?: 'download' | 'agent' | 'extension';
  locale?: string | null;
  brand: 'roboapply' | 'goapply';
  market: 'intl' | 'cn';
  /** Visitor country (edge header), for the Letter/A4 default. */
  country?: string | null;
}

export interface ExportResult {
  buffer: Buffer;
  fileName: string;
  ext: ExportFormat;
  contentType: string;
  sha256: string;
  artifactId: string | null;
  storageKey: string | null;
  /** The AI content id written into the file's metadata, or null. */
  aiContentId: string | null;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Keyspace for exported application files (kept 180 days; compliance retention). */
export const ARTIFACT_KEYSPACE = 'roboapply-artifacts';

export class ResumeNotFoundError extends Error {
  constructor() {
    super('Resume not found');
    this.name = 'ResumeNotFoundError';
  }
}

export class ResumeInUseError extends Error {
  trackerCount: number;
  constructor(trackerCount: number) {
    super('Resume still in use');
    this.name = 'ResumeInUseError';
    this.trackerCount = trackerCount;
  }
}

export class ResumeValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ResumeValidationError';
  }
}

/** Upload could not be read/parsed. `code` ∈ extract_failed | empty_text |
 *  parse_failed. The route maps this to 422 with a structured `code`. */
export class ResumeUploadError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.name = 'ResumeUploadError';
    this.code = code;
  }
}

/** Resume files one user may upload in a day (uploads and LinkedIn PDF imports together). */
export const RESUME_UPLOADS_PER_DAY = 10;
/** Counter name for the daily upload cap (`RARateCounter` key `rl:<brand>:resumeUploadPerUser:user:<id>`). */
export const RESUME_UPLOAD_LIMIT_NAME = 'resumeUploadPerUser';

/** The user reached RESUME_UPLOADS_PER_DAY (route → 429 rate_limited with Retry-After). */
export class ResumeUploadLimitError extends Error {
  readonly code = 'rate_limited' as const;
  readonly limit = RESUME_UPLOADS_PER_DAY;
  constructor(readonly retryAfterSec: number) {
    super(`You can upload up to ${RESUME_UPLOADS_PER_DAY} resume files a day. Try again tomorrow.`);
    this.name = 'ResumeUploadLimitError';
  }
}

/**
 * GoApply: reading a resume file is AI processing (the parse service and the
 * local parser both use models), so it needs the user's `ai_resume_parsing`
 * consent (TASK_PLAN.md §2.2). Without it the upload is refused before
 * anything is read (route → 503 ai_unavailable, details.reason
 * ai_consent_required); the user can build the resume by hand instead.
 */
export class ResumeParseConsentError extends Error {
  readonly code = 'ai_unavailable' as const;
  readonly reason = 'ai_consent_required' as const;
  constructor() {
    super('Reading a resume file uses AI, which is off for this account.');
    this.name = 'ResumeParseConsentError';
  }
}

/** Throws ResumeParseConsentError for a GoApply user without the AI consent. RoboApply always passes. */
export async function assertParseConsent(userId: string): Promise<void> {
  const brand = getCurrentBrandOrDefault();
  if (brand.market !== 'cn') return;
  if (!(await aiAllowed({ id: userId, brand: brand.id }))) throw new ResumeParseConsentError();
}

/**
 * Whether this user's upload may be read by the GoHire parse service.
 *   GoApply   → the brand rule decides (`GOHIRE_PARSE_BRANDS`, egress policy).
 *   RoboApply → only when the owner opted the brand in AND the user's newest
 *               answer to `intl_cross_border_cn_parse` is a grant. Declined,
 *               never answered or an unreadable answer all mean no.
 */
export async function remoteParseAllowed(userId: string): Promise<boolean> {
  const brand = getCurrentBrandOrDefault();
  if (brand.market === 'cn') return true;
  if (!goHireParseActive(brand.id)) return false;
  try {
    return await hasLiveConsent(userId, 'intl_cross_border_cn_parse');
  } catch (err) {
    logger.warn('RA_V2_RESUME', 'parse consent lookup failed; using the local parser', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function sha256(s: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

/**
 * Idempotent re-ingest decision: given the parsed content hash, return the id
 * of an existing active base variant with identical content (so a re-upload of
 * the same résumé returns the existing variant instead of creating a duplicate
 * row + re-storing the bytes), or null to proceed with a fresh create.
 *
 * The lookup is injected so the decision is unit-testable without a DB (see the
 * resolveTailorScores pattern). An empty hash never dedups.
 */
export async function findBaseDuplicateId(
  contentHash: string,
  findActiveBaseByHash: (hash: string) => Promise<{ id: string } | null>,
): Promise<string | null> {
  if (!contentHash) return null;
  const dup = await findActiveBaseByHash(contentHash);
  return dup?.id ?? null;
}

/** The columns `legacyJobVisible` reads (market, visibility, owner, source). One definition, type-checked against the model. */
const JOB_SCOPE_SELECT = LEGACY_JOB_SCOPE_SELECT;

function isoDate(d: any): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function toView(row: any): RAResumeVariantView {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: row.kind as RAResumeKind,
    targetJobId: row.targetJobId ?? null,
    basedOnVariantId: row.basedOnVariantId ?? null,
    templateKey: row.templateKey ?? null,
    resumeMarkdown: row.resumeMarkdown ?? '',
    resumeContentHash: row.resumeContentHash,
    matchScoreCached: row.matchScoreCached ?? null,
    isPrimary: row.isPrimary ?? false,
    sourceKind: row.sourceKind ?? null,
    parseStatus: row.parseStatus ?? null,
    summary: row.summary ?? null,
    highlight: row.highlight ?? null,
    originalFileName: row.originalFileName ?? null,
    hasOriginalFile: !!row.originalFileKey,
    lastEditedAt: isoDate(row.lastEditedAt),
    createdAt: isoDate(row.createdAt),
    deletedAt: row.deletedAt ? isoDate(row.deletedAt) : null,
    layout: row.layout && typeof row.layout === 'object' ? (row.layout as Record<string, unknown>) : null,
    targetTitle: row.targetTitle ?? null,
    unverifiedClaims: typeof row.unverifiedClaims === 'number' ? row.unverifiedClaims : 0,
    aiAssisted: isAiAssisted(row),
  };
}

function toSummary(row: any, jobsById: Map<string, any>, sessionByVariant: Record<string, string> = {}): RAResumeVariantSummary {
  const targetJob = row.targetJobId ? jobsById.get(row.targetJobId) : null;
  const unverified = typeof row.unverifiedClaims === 'number' ? row.unverifiedClaims : 0;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as RAResumeKind,
    targetJobId: row.targetJobId ?? null,
    targetJobTitle: targetJob?.title ?? null,
    targetJobCompany: targetJob?.companyName ?? null,
    matchScoreCached: row.matchScoreCached ?? null,
    isPrimary: row.isPrimary ?? false,
    sourceKind: row.sourceKind ?? null,
    lastEditedAt: isoDate(row.lastEditedAt),
    createdAt: isoDate(row.createdAt),
    targetTitle: row.targetTitle ?? null,
    basedOnVariantId: row.basedOnVariantId ?? null,
    unverifiedClaims: unverified,
    tailorSessionId: unverified > 0 ? (sessionByVariant[row.id] ?? null) : null,
  };
}

export class RAResumeService {
  async list(userId: string, kind?: RAResumeKind): Promise<RAResumeVariantSummary[]> {
    const p = prisma as any;
    const where: any = { userId, deletedAt: null };
    if (kind) where.kind = kind;
    const rows = await p.rAResumeVariant.findMany({
      where,
      orderBy: { lastEditedAt: 'desc' },
    });
    const jobIds = (rows as any[]).map((r) => r.targetJobId).filter((x: any): x is string => !!x);
    const jobs = jobIds.length
      ? await p.rAJob.findMany({
          where: { id: { in: jobIds } },
          select: { id: true, title: true, companyName: true, ...JOB_SCOPE_SELECT },
        })
      : [];
    // Only jobs this user may read here (market, own imports, GoApply R-14
    // mode) lend their title and company to a resume card.
    const jobsById = new Map<string, any>((jobs as any[]).filter((j) => legacyJobVisible(j, userId)).map((j: any) => [j.id, j]));
    // Versions with details still to verify link back to their tailor session.
    const unverifiedIds = (rows as any[]).filter((r) => typeof r.unverifiedClaims === 'number' && r.unverifiedClaims > 0).map((r) => r.id as string);
    const sessionByVariant = unverifiedIds.length ? await this.reviewSessions(userId, unverifiedIds) : {};
    return (rows as any[]).map((r) => toSummary(r, jobsById, sessionByVariant));
  }

  /** Variant id → tailor session in review. The list still loads when this read fails (no link shown). */
  private async reviewSessions(userId: string, variantIds: string[]): Promise<Record<string, string>> {
    try {
      const { getTailorService } = await import('../../../features/resume/index.js');
      return await getTailorService().reviewSessionIds(userId, variantIds);
    } catch (err) {
      logger.warn('RA_V2_RESUME', 'tailor sessions not read for the hub', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  async getById(userId: string, id: string): Promise<RAResumeVariantView> {
    const p = prisma as any;
    const row = await p.rAResumeVariant.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!row) throw new ResumeNotFoundError();
    return toView(row);
  }

  /**
   * Reconcile the exactly-one-primary invariant for a user inside a single
   * transaction. Converges from 0 primaries (promote the newest active résumé —
   * this is what auto-promotes a user's first/only résumé) AND from 2+ primaries
   * (keep the newest, demote the rest — self-heals any duplicate-primary state
   * left by a concurrent write). Idempotent: a no-op when exactly one active
   * primary already exists. Called after every create/upload/delete so the
   * system converges to exactly-one without relying on a count-then-write race
   * or a DB partial-unique index (not expressible under the db-push workflow).
   */
  private async normalizePrimary(userId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const t = tx as any;
      const primaries: Array<{ id: string }> = await t.rAResumeVariant.findMany({
        where: { userId, isPrimary: true, deletedAt: null },
        orderBy: { lastEditedAt: 'desc' },
        select: { id: true },
      });
      if (primaries.length === 1) return;
      if (primaries.length > 1) {
        await t.rAResumeVariant.updateMany({
          where: { userId, isPrimary: true, deletedAt: null, id: { not: primaries[0].id } },
          data: { isPrimary: false },
        });
        return;
      }
      // Zero primaries — promote the most-recently-edited active BASE résumé,
      // if any. A tailored version is job-specific and the hub hides it, so it
      // never becomes the primary (F-RES-02).
      const next = await t.rAResumeVariant.findFirst({
        where: { userId, deletedAt: null, kind: { in: BASE_SLOT_KINDS } },
        orderBy: { lastEditedAt: 'desc' },
        select: { id: true },
      });
      if (next) {
        await t.rAResumeVariant.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
  }

  /** Re-read a variant and project it to a view (used after normalizePrimary,
   *  which may have flipped isPrimary on the just-created row). */
  private async reloadView(id: string): Promise<RAResumeVariantView> {
    const p = prisma as any;
    const row = await p.rAResumeVariant.findUnique({ where: { id } });
    if (!row) throw new ResumeNotFoundError();
    return toView(row);
  }

  async create(userId: string, body: ResumeCreateInput, locale?: string): Promise<RAResumeVariantView> {
    const p = prisma as any;
    if (!body.name || !body.name.trim()) {
      throw new ResumeValidationError('name is required');
    }

    if (body.kind === 'base' || body.kind === 'from_template') {
      await this.assertBaseSlotFree(userId);
    }

    if (body.kind === 'base') {
      const md = body.resumeMarkdown ?? '';
      const created = await p.rAResumeVariant.create({
        data: {
          userId,
          name: body.name.trim(),
          kind: 'base',
          targetJobId: null,
          basedOnVariantId: null,
          templateKey: null,
          resumeMarkdown: md,
          resumeContentHash: sha256(md),
          matchScoreCached: null,
          sourceKind: 'scratch',
          lastEditedAt: new Date(),
        },
      });
      logger.info('RA_V2_RESUME', 'resume created (base)', { userId, resumeId: created.id });
      await this.normalizePrimary(userId);
      return this.reloadView(created.id);
    }

    if (body.kind === 'from_template') {
      const md = `# Your name\n\n_Your title_ · your@email.com\n\n[Generated from the ${body.templateKey} template.]`;
      const created = await p.rAResumeVariant.create({
        data: {
          userId,
          name: body.name.trim(),
          kind: 'from_template',
          targetJobId: null,
          basedOnVariantId: null,
          templateKey: body.templateKey,
          resumeMarkdown: md,
          resumeContentHash: sha256(md),
          matchScoreCached: null,
          sourceKind: 'template',
          lastEditedAt: new Date(),
        },
      });
      logger.info('RA_V2_RESUME', 'resume created (template)', {
        userId,
        resumeId: created.id,
        templateKey: body.templateKey,
      });
      await this.normalizePrimary(userId);
      return this.reloadView(created.id);
    }

    throw new ResumeValidationError('unsupported kind');
  }

  /**
   * The legacy `POST /resumes { kind: 'tailored_for_jd' }`, on tailor sessions.
   * One `tailor` credit (reserved before the model runs, kept only when the
   * version is saved), the GoApply phone and AI-consent gates, the claim check
   * and `unverifiedClaims` all come from `TailorService.create` — the same
   * code path as `POST /resumes/tailor-sessions` in fast mode with every
   * section. Its errors pass through (404 not_found, 503 ai_unavailable, 402
   * credits_exhausted, 403 phone_binding_required, 409 conflict).
   */
  async createTailoredForJob(
    userId: string,
    body: TailoredCreateInput,
    opts: { idempotencyKey: string; locale?: string },
  ): Promise<TailoredCreateResult> {
    const { resumeSuiteService } = await import('../../../features/resume/index.js');
    const session = await resumeSuiteService.createTailorSession(userId, {
      baseVariantId: body.basedOnVariantId,
      jobId: body.targetJobId,
      idempotencyKey: opts.idempotencyKey,
      mode: 'fast',
      locale: opts.locale,
    });
    if (!session.resultVariantId) {
      // A replayed key whose first run has not saved its version yet.
      throw new ResumeValidationError('tailor_in_progress');
    }
    const name = body.name?.trim().slice(0, 200);
    if (name) {
      await (prisma as any).rAResumeVariant.updateMany({
        where: { id: session.resultVariantId, userId, deletedAt: null },
        data: { name },
      });
    }
    logger.info('RA_V2_RESUME', 'tailored version created through a tailor session', {
      userId,
      resumeId: session.resultVariantId,
      tailorSessionId: session.id,
      pendingClaims: session.pendingClaims,
    });
    return { resume: await this.reloadView(session.resultVariantId), tailorSessionId: session.id, pendingClaims: session.pendingClaims };
  }

  /**
   * Upload + parse a résumé file into a new kind='base' variant. Reuses the
   * RoboHire parse pipeline via the candidate ingest helper (no recruiter
   * Resume table, no recruiter quota). The original bytes are stored in
   * candidate-scoped object storage. The first résumé becomes primary.
   */
  async uploadAndCreate(
    userId: string,
    params: {
      buffer: Buffer;
      fileName: string;
      mimeType: string;
      requestId?: string;
      name?: string;
      /** Opaque per-file token from the client (see schema). */
      idempotencyKey?: string;
      /**
       * RoboApply: read the file on this server only (no GoHire parse),
       * whatever the consent answer. Ignored on GoApply, where GoHire is the
       * preferred parser whenever it is configured (the local pipeline is its
       * fallback).
       */
      localParser?: boolean;
    },
    // Optional trailing so non-route callers keep compiling; the ingest only
    // uses it for the AI summary/highlight shown on the résumé card.
    locale?: string,
  ): Promise<RAResumeVariantView> {
    const p = prisma as any;

    // Retry of an upload that already landed → hand back the existing row
    // BEFORE re-running the 45-80s parse. This is the dedupe that actually
    // fires for uploads: the resumeContentHash check below it hashes
    // LLM-produced markdown, which is not reproducible across two parses of
    // the same bytes.
    if (params.idempotencyKey) {
      const prior = await p.rAResumeVariant.findFirst({
        where: { userId, uploadIdempotencyKey: params.idempotencyKey, deletedAt: null },
        select: { id: true },
      });
      if (prior) {
        logger.info('RA_V2_RESUME', 'upload replayed (idempotency key hit)', {
          userId,
          resumeId: prior.id,
        });
        return this.reloadView(prior.id);
      }
    }
    // Refuse before the 45-80 s parse: the hub keeps up to 5 base resumes.
    await this.assertBaseSlotFree(userId);
    // GoApply: no file is read (by the parse service or a model) without the AI consent.
    await assertParseConsent(userId);
    // A replay above costs nothing; a new parse counts toward the day's cap.
    await this.consumeUploadAllowance(userId);
    // Privacy: the file leaves this server for GoHire only when the user's
    // brand and consent allow it. On GoApply the caller's `localParser` flag
    // is ignored: GoHire is its preferred parser, tried first whenever it is
    // configured, and the local pipeline is the fallback.
    const cnMarket = getCurrentBrandOrDefault().market === 'cn';
    const forceLocalParser = !cnMarket && (params.localParser === true || !(await remoteParseAllowed(userId)));

    let ingest: CandidateResumeIngestResult;
    try {
      ingest = await ingestCandidateResume({
        buffer: params.buffer,
        fileName: params.fileName,
        mimeType: params.mimeType,
        requestId: params.requestId,
        userId,
        locale,
        forceLocalParser,
      });
    } catch (err) {
      if (err instanceof CandidateResumeIngestError) {
        throw new ResumeUploadError(err.code, err.message);
      }
      throw err;
    }

    return this.persistIngestedBase(userId, ingest, {
      name: params.name,
      sourceKind: 'upload',
      fallbackFileName: params.fileName,
      fallbackMimeType: params.mimeType,
      fallbackSize: params.buffer.byteLength,
      idempotencyKey: params.idempotencyKey,
    });
  }

  /**
   * Persist a freshly-ingested résumé as a new kind='base' variant. Shared by
   * the file-upload path and the LinkedIn-import path so the column mapping +
   * primary reconciliation live in exactly one place. `sourceKind` distinguishes
   * origin ('upload' | 'linkedin') for the list UI badge. The original-file
   * columns are only populated when the ingest actually stored bytes (LinkedIn
   * URL imports have no original file).
   */
  private async persistIngestedBase(
    userId: string,
    ingest: CandidateResumeIngestResult,
    opts: {
      name?: string;
      sourceKind: 'upload' | 'linkedin';
      fallbackFileName?: string;
      fallbackMimeType?: string;
      fallbackSize?: number;
      /** Opaque per-file upload token; see the schema field of the same name. */
      idempotencyKey?: string;
    },
  ): Promise<RAResumeVariantView> {
    const p = prisma as any;

    // Idempotent re-ingest: identical parsed content for this user → return the
    // existing base variant instead of a duplicate row + re-stored bytes. (The
    // parse already ran; skipping the parse too would need a pre-parse rawText
    // hash + column — tracked as a follow-up.)
    const contentHash = sha256(ingest.markdown);
    const dupId = await findBaseDuplicateId(contentHash, (hash) =>
      p.rAResumeVariant.findFirst({
        where: { userId, kind: 'base', resumeContentHash: hash, deletedAt: null },
        orderBy: { lastEditedAt: 'asc' },
        select: { id: true },
      }),
    );
    if (dupId) {
      logger.info('RA_V2_RESUME', `resume re-ingest deduped (${opts.sourceKind})`, {
        userId,
        resumeId: dupId,
      });
      return this.reloadView(dupId);
    }

    const createData = {
      data: {
        userId,
        name: opts.name?.trim() || ingest.displayName,
        kind: 'base',
        targetJobId: null,
        basedOnVariantId: null,
        templateKey: null,
        resumeMarkdown: ingest.markdown,
        resumeContentHash: contentHash,
        matchScoreCached: null,
        sourceKind: opts.sourceKind,
        parseStatus: 'parsed',
        rawText: ingest.rawText,
        parsedData: ingest.parsed as any,
        summary: ingest.summary || null,
        highlight: ingest.highlight || null,
        originalFileProvider: ingest.original?.provider ?? null,
        originalFileKey: ingest.original?.key ?? null,
        originalFileName: ingest.original?.fileName ?? opts.fallbackFileName ?? null,
        originalFileMimeType: ingest.original?.mimeType ?? opts.fallbackMimeType ?? null,
        originalFileSize: ingest.original?.size ?? opts.fallbackSize ?? null,
        uploadIdempotencyKey: opts.idempotencyKey ?? null,
        lastEditedAt: new Date(),
      },
    };

    let created: { id: string };
    try {
      created = await p.rAResumeVariant.create(createData);
    } catch (err) {
      // Two uploads of the same file raced (the user retried while the first
      // parse was still running) and the other one won @@unique([userId,
      // uploadIdempotencyKey]). Both parses burned, but only one row exists —
      // hand back the winner instead of surfacing a 500.
      const winnerId = opts.idempotencyKey
        ? await this.findByIdempotencyKey(userId, opts.idempotencyKey, err)
        : null;
      if (!winnerId) throw err;
      logger.info('RA_V2_RESUME', 'upload lost the idempotency race', {
        userId,
        resumeId: winnerId,
      });
      return this.reloadView(winnerId);
    }
    logger.info('RA_V2_RESUME', `resume created (${opts.sourceKind})`, {
      userId,
      resumeId: created.id,
      hasOriginal: !!ingest.original,
    });
    await this.normalizePrimary(userId);
    return this.reloadView(created.id);
  }

  /**
   * Resolve the row that already holds `key` — but only when `err` is the
   * unique-constraint violation on @@unique([userId, uploadIdempotencyKey]).
   * Any other failure (a dropped connection, a bad column) must keep bubbling,
   * or a genuinely broken create would masquerade as a successful replay.
   */
  private async findByIdempotencyKey(
    userId: string,
    key: string,
    err: unknown,
  ): Promise<string | null> {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== 'P2002') return null;
    const row = await (prisma as any).rAResumeVariant.findFirst({
      where: { userId, uploadIdempotencyKey: key, deletedAt: null },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Import the user's own LinkedIn "Save to PDF" export into a new kind='base'
   * variant tagged `sourceKind: 'linkedin'`. The PDF goes through the same
   * candidate ingest as a normal upload, with the export's page footers
   * stripped first. FREE (no quota debit), like /upload.
   *
   * There is no LinkedIn URL import (TASK_PLAN.md H9; PRODUCT_PLAN.md O5): the
   * only providers scrape LinkedIn. `mode: 'url'` answers
   * `url_import_removed`.
   */
  async importFromLinkedIn(
    userId: string,
    params: {
      mode: 'pdf' | 'url';
      buffer?: Buffer;
      fileName?: string;
      mimeType?: string;
      linkedinUrl?: string;
      name?: string;
      requestId?: string;
    },
    // Optional trailing so non-route callers keep compiling; the ingest only
    // uses it for the AI summary/highlight shown on the résumé card.
    locale?: string,
  ): Promise<RAResumeVariantView> {
    if (params.mode !== 'pdf') {
      throw new ResumeUploadError('url_import_removed', 'LinkedIn URL import is not offered. Upload your LinkedIn PDF export instead.');
    }
    if (!params.buffer || params.buffer.length === 0) {
      throw new ResumeUploadError('file_required', 'A LinkedIn PDF export is required.');
    }
    await this.assertBaseSlotFree(userId);
    await assertParseConsent(userId);
    await this.consumeUploadAllowance(userId);
    let ingest: CandidateResumeIngestResult;
    try {
      ingest = await ingestCandidateResume({
        buffer: params.buffer,
        fileName: params.fileName || 'linkedin.pdf',
        mimeType: params.mimeType || 'application/pdf',
        requestId: params.requestId,
        userId,
        textTransform: cleanProfileExportText,
        locale,
      });
    } catch (err) {
      if (err instanceof CandidateResumeIngestError) {
        throw new ResumeUploadError(err.code, err.message);
      }
      throw err;
    }
    return this.persistIngestedBase(userId, ingest, {
      name: params.name,
      sourceKind: 'linkedin',
      fallbackFileName: params.fileName || 'LinkedIn export.pdf',
      fallbackMimeType: params.mimeType || 'application/pdf',
      fallbackSize: params.buffer.byteLength,
    });
  }

  /**
   * Mark one variant as the user's primary résumé, demoting any other. Runs in
   * a single transaction so there is never zero or two primaries.
   */
  async setPrimary(userId: string, id: string): Promise<RAResumeVariantView> {
    const p = prisma as any;
    const existing = await p.rAResumeVariant.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new ResumeNotFoundError();
    // Only a base resume can be the primary (F-RES-02): tailored versions are
    // job-specific and not shown as hub cards.
    if (!BASE_SLOT_KINDS.includes(existing.kind as RAResumeKind)) {
      throw new ResumeValidationError('Only a base resume can be your primary resume.');
    }
    await prisma.$transaction([
      p.rAResumeVariant.updateMany({
        where: { userId, isPrimary: true, id: { not: id } },
        data: { isPrimary: false },
      }),
      p.rAResumeVariant.update({ where: { id }, data: { isPrimary: true } }),
    ]);
    const row = await p.rAResumeVariant.findUnique({ where: { id } });
    logger.info('RA_V2_RESUME', 'resume set primary', { userId, resumeId: id });
    return toView(row);
  }

  /** Fetch the stored-original-file ref for an owned variant (download path). */
  async getOriginalFileRef(
    userId: string,
    id: string,
  ): Promise<{ provider: string; key: string; fileName: string; mimeType: string } | null> {
    const p = prisma as any;
    const row = await p.rAResumeVariant.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!row) throw new ResumeNotFoundError();
    if (!row.originalFileProvider || !row.originalFileKey) return null;
    return {
      provider: row.originalFileProvider,
      key: row.originalFileKey,
      fileName: row.originalFileName ?? 'resume',
      mimeType: row.originalFileMimeType ?? 'application/octet-stream',
    };
  }

  /** How many of the BASE_RESUME_LIMIT base slots are taken (tailored versions excluded). */
  async baseSlotsUsed(userId: string): Promise<number> {
    const p = prisma as any;
    return p.rAResumeVariant.count({ where: { userId, deletedAt: null, kind: { in: BASE_SLOT_KINDS } } });
  }

  /** Throws ResumeLimitError when every base slot is taken. */
  async assertBaseSlotFree(userId: string): Promise<void> {
    if ((await this.baseSlotsUsed(userId)) >= BASE_RESUME_LIMIT) throw new ResumeLimitError();
  }

  /**
   * Count one upload against the user's daily cap (persisted in
   * `RARateCounter`, so it holds across serverless instances). Throws
   * ResumeUploadLimitError when the day's allowance is used up. A counter
   * that cannot be read never blocks an upload (logged).
   */
  async consumeUploadAllowance(userId: string): Promise<void> {
    let result: { allowed: boolean; retryAfterSec: number };
    try {
      result = await consumeRateLimit({
        key: rateLimitKey(RESUME_UPLOAD_LIMIT_NAME, 'user', userId),
        windows: [{ limit: RESUME_UPLOADS_PER_DAY, windowSec: DAY }],
      });
    } catch (err) {
      logger.warn('RA_V2_RESUME', 'upload cap not checked (counter unavailable)', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!result.allowed) throw new ResumeUploadLimitError(result.retryAfterSec);
  }

  /**
   * `PATCH /:id/layout` — merge a layout patch into `RAResumeVariant.layout`.
   * `layout` arrives validated by the contract's ResumeLayoutSchema; keys the
   * schema does not know (legacy editor keys) are dropped on write. The
   * template lands in `layout.template`, which the resume check reads to flag
   * the two-column template.
   */
  async patchLayout(userId: string, id: string, layout: Record<string, unknown>): Promise<RAResumeVariantView> {
    const p = prisma as any;
    const existing = await p.rAResumeVariant.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new ResumeNotFoundError();
    const prev = existing.layout && typeof existing.layout === 'object' ? (existing.layout as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = {};
    for (const key of LAYOUT_KEYS) {
      const next = key in layout ? layout[key] : prev[key];
      if (next === undefined || next === null) continue;
      if ((key === 'sizes' || key === 'spacing') && typeof next === 'object') {
        const base = prev[key] && typeof prev[key] === 'object' ? (prev[key] as Record<string, unknown>) : {};
        merged[key] = { ...base, ...(layout[key] as Record<string, unknown> | undefined) };
      } else {
        merged[key] = next;
      }
    }
    const row = await p.rAResumeVariant.update({ where: { id }, data: { layout: merged, lastEditedAt: new Date() } });
    logger.info('RA_V2_RESUME', 'resume layout saved', { userId, resumeId: id, template: merged.template ?? null });
    return toView(row);
  }

  /**
   * Unverified inserted claims for a variant. The tailor-session count
   * (`resume.unverifiedClaimsCount`, WP-36a) wins; until that seam is filled
   * the variant's own `unverifiedClaims` column answers.
   */
  private async pendingClaims(variant: { id: string; unverifiedClaims?: number | null }): Promise<number> {
    const column = typeof variant.unverifiedClaims === 'number' ? variant.unverifiedClaims : 0;
    try {
      const { unverifiedClaimsCount } = await import('../../../features/resume/index.js');
      return await unverifiedClaimsCount(variant.id);
    } catch (err) {
      if (err instanceof NotImplementedError || (err as { code?: string } | null)?.code === 'not_implemented') return column;
      throw err;
    }
  }

  /**
   * Export a variant as PDF or DOCX (F-RES-13/15). Refuses while inserted
   * claims are unverified (ruling C12). AI-written variants carry the
   * machine-readable AI marks on both brands, plus the visible footer on
   * GoApply when CN_AI_EXPORT_EXPLICIT_LABEL is on, and GoApply writes one
   * RAAiContentLabelLog row. With `trackerEntryId` the exact bytes are stored
   * and an RAApplicationArtifact row records sha256 + storage key. With
   * `autoTrack` the same record is made on the user's application for the job
   * this version was tailored for, when one exists.
   */
  async exportVariant(userId: string, id: string, req: ExportRequest): Promise<ExportResult> {
    const p = prisma as any;
    const variant = await p.rAResumeVariant.findFirst({ where: { id, userId, deletedAt: null } });
    if (!variant) throw new ResumeNotFoundError();

    const pending = await this.pendingClaims(variant);
    if (pending > 0) throw new UnverifiedClaimsError(pending);

    let tracker: { id: string; jobId: string | null; externalSnapshot: unknown } | null = null;
    if (req.trackerEntryId) {
      tracker = await p.rATrackerEntry.findFirst({
        where: { id: req.trackerEntryId, userId, deletedAt: null },
        select: { id: true, jobId: true, externalSnapshot: true },
      });
      if (!tracker) throw new TrackerEntryNotFoundError();
    }
    // A download that names no application (the editor, the hub): a version
    // tailored for a job belongs to the user's application for that job, so
    // the file is recorded there. Never fails the download.
    let autoTracked = false;
    if (!tracker && req.autoTrack && variant.targetJobId) {
      try {
        tracker = await p.rATrackerEntry.findFirst({
          where: { userId, jobId: variant.targetJobId, deletedAt: null },
          select: { id: true, jobId: true, externalSnapshot: true },
        });
        autoTracked = Boolean(tracker);
      } catch (err) {
        logger.warn('RA_V2_RESUME', 'application for the tailored version not read; the file is not recorded', {
          userId,
          resumeId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // File-name parts come only from data we hold (never invented), and a job
    // lends its company and title only when this user may read it here: the
    // brand's market, a public row or the user's own import, and on GoApply
    // the recruitment-info mode (R-14: with the mode off a third-party posting
    // is never named, not even in a file name).
    const jobId = variant.targetJobId ?? tracker?.jobId ?? null;
    const jobRow = jobId
      ? await p.rAJob.findUnique({ where: { id: jobId }, select: { title: true, companyName: true, ...JOB_SCOPE_SELECT } })
      : null;
    const job = legacyJobVisible(jobRow, userId, { market: req.market }) ? jobRow : null;
    const snapshot = (tracker?.externalSnapshot ?? null) as { title?: unknown; companyName?: unknown } | null;
    const tailorTarget =
      (variant.parsedData as { tailorTarget?: { company?: string | null; title?: string | null } } | null)?.tailorTarget ??
      (job || snapshot ? null : await this.pastedTarget(userId, variant));
    const markdown: string = variant.resumeMarkdown ?? '';
    const candidateName = /^#\s+(.+)$/m.exec(markdown)?.[1]?.replace(/[*_`]/g, '').trim() ?? null;
    const company = job?.companyName ?? (typeof snapshot?.companyName === 'string' ? snapshot.companyName : null) ?? tailorTarget?.company ?? null;
    const role = job?.title ?? (typeof snapshot?.title === 'string' ? snapshot.title : null) ?? tailorTarget?.title ?? variant.targetTitle ?? null;
    const baseName = buildExportFileName(req.nameStyle ?? null, {
      name: candidateName,
      company,
      role,
      fallback: variant.name || 'Resume',
    });

    // AI labelling (WP-13 seams). No user text goes into the label.
    let aiLabel: ImplicitAiLabel | null = null;
    let footerLine: string | null = null;
    let aiContentId: string | null = null;
    const compliance = isAiAssisted(variant) ? await import('../../../features/compliance/index.js') : null;
    if (compliance) {
      aiContentId = compliance.newAiContentId(req.brand);
      const editedAfter = variant.lastEditedAt && variant.createdAt && new Date(variant.lastEditedAt).getTime() - new Date(variant.createdAt).getTime() > 1000;
      aiLabel = compliance.complianceService.implicitLabelMetadata({ contentId: aiContentId, provider: 'llm', brand: req.brand, userEdited: Boolean(editedAfter) });
      if (compliance.explicitLabelEnabled(req.brand)) footerLine = compliance.explicitFooterLine(req.locale ?? (req.market === 'cn' ? 'zh' : 'en'));
    }

    const defaultPage: PageSize = defaultPageFor({ market: req.market, country: req.country, locale: req.locale });
    const renderOptions = { layout: variant.layout, defaultPage, locale: req.locale, aiLabel, footerLine, title: candidateName ?? variant.name };
    const buffer = req.format === 'pdf' ? await renderResumePdf(markdown, renderOptions) : await renderResumeDocx(markdown, renderOptions);
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileName = `${baseName}.${req.format}`;

    let artifactId: string | null = null;
    let storageKey: string | null = null;
    // A photo from the user's device is never stored: an application found by
    // `autoTrack` then gets the record (name, sha256) without a kept copy.
    const keepCopy = !(autoTracked && req.photoInFile);
    if (tracker && !keepCopy) {
      logger.info('RA_V2_RESUME', 'export recorded without a stored copy (the file carries a device photo)', { userId, resumeId: id });
    }
    if (tracker) {
      const { resumeOriginalFileStorageService } = await import('../../../services/ResumeOriginalFileStorageService.js');
      if (keepCopy) {
        try {
          const stored = await resumeOriginalFileStorageService.saveFile({
            buffer,
            fileName,
            mimeType: CONTENT_TYPES[req.format],
            size: buffer.byteLength,
            userId,
            keyspace: ARTIFACT_KEYSPACE,
            brand: req.brand,
            requestId: getCurrentRequestId() ?? undefined,
          });
          storageKey = stored?.key ?? null;
        } catch (err) {
          // The download still works; the record keeps the hash without a stored copy.
          logger.warn('RA_V2_RESUME', 'export file not stored', {
            userId,
            resumeId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        const artifact = await p.rAApplicationArtifact.create({
          data: {
            userId,
            trackerEntryId: tracker.id,
            kind: 'resume',
            variantId: variant.id,
            fileName,
            format: req.format,
            fileSha256: sha,
            storageKey,
            channel: req.channel ?? 'download',
          },
          select: { id: true },
        });
        artifactId = artifact.id;
      } catch (err) {
        // The caller named this application: the record is part of the request.
        if (!autoTracked) throw err;
        // Found by `autoTrack`: the user asked for a download, which still works.
        logger.warn('RA_V2_RESUME', 'export not recorded on the application', { userId, resumeId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (compliance && aiContentId) {
      await compliance.logAiContentLabel({ userId, contentId: aiContentId, kind: 'resume', provider: 'llm', artifactId: artifactId ?? variant.id, brand: req.brand });
    }

    logger.info('RA_V2_RESUME', 'resume exported', {
      userId,
      resumeId: id,
      format: req.format,
      artifactId,
      stored: Boolean(storageKey),
      aiLabelled: Boolean(aiContentId),
    });
    return { buffer, fileName, ext: req.format, contentType: CONTENT_TYPES[req.format], sha256: sha, artifactId, storageKey, aiContentId };
  }

  /**
   * The company and title a version was tailored for when it came from a
   * PASTED posting: there is no job row, the target is on the tailor session
   * that made the version (`RATailorSession.jdSnapshot`). Without it the file
   * of such a version was named with the candidate's name only, whatever name
   * style was picked. Null when the version has no such session; never throws.
   */
  private async pastedTarget(userId: string, variant: { id: string; kind?: string | null; sourceKind?: string | null }): Promise<{ company: string | null; title: string | null } | null> {
    if (variant.kind !== 'tailored_for_jd' && variant.sourceKind !== 'tailored') return null;
    try {
      const session = await (prisma as any).rATailorSession.findFirst({
        where: { userId, resultVariantId: variant.id },
        orderBy: { createdAt: 'desc' },
        select: { jdSnapshot: true },
      });
      const jd = (session?.jdSnapshot ?? null) as { title?: unknown; company?: unknown } | null;
      const title = typeof jd?.title === 'string' && jd.title.trim() ? jd.title.trim() : null;
      const company = typeof jd?.company === 'string' && jd.company.trim() ? jd.company.trim() : null;
      return title || company ? { company, title } : null;
    } catch (err) {
      logger.debug('RA_V2_RESUME', 'tailor session not read for the file name', { userId, resumeId: variant.id, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async patch(userId: string, id: string, body: ResumePatchInput): Promise<RAResumeVariantView> {
    const p = prisma as any;
    const existing = await p.rAResumeVariant.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new ResumeNotFoundError();
    const data: any = { lastEditedAt: new Date() };
    if (body.name !== undefined) data.name = body.name;
    if (body.targetTitle !== undefined) {
      const tt = typeof body.targetTitle === 'string' ? body.targetTitle.trim().slice(0, 120) : '';
      data.targetTitle = tt || null;
    }
    if (body.aiAssisted === true && !existing.aiAssistedAt) {
      data.aiAssistedAt = new Date();
    }
    if (body.resumeMarkdown !== undefined) {
      data.resumeMarkdown = body.resumeMarkdown;
      data.resumeContentHash = sha256(body.resumeMarkdown);
      // Mark all RAJobMatchScore rows referencing this variant as stale via
      // hash mismatch — the column `resumeContentHashAtScore` will no longer
      // equal `resumeContentHash` and the scorer treats that as stale.
    }
    const row = await p.rAResumeVariant.update({ where: { id }, data });
    return toView(row);
  }

  async delete(userId: string, id: string): Promise<void> {
    const p = prisma as any;
    const existing = await p.rAResumeVariant.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new ResumeNotFoundError();
    // 409 if this is the only base resume AND tracker entries reference it.
    if (existing.kind === 'base') {
      const otherBase = await p.rAResumeVariant.count({
        where: { userId, kind: 'base', deletedAt: null, id: { not: id } },
      });
      if (otherBase === 0) {
        const dependents = await p.rATrackerEntry.count({
          where: { userId, jobId: { not: null }, deletedAt: null },
        });
        if (dependents > 0) {
          throw new ResumeInUseError(dependents);
        }
      }
    }
    await p.rAResumeVariant.update({
      where: { id },
      // Release the upload key with the row: the unique index spans soft-deleted
      // rows too, so keeping it would make re-uploading the same file after a
      // delete either collide or replay the deleted résumé back at the user.
      data: { deletedAt: new Date(), uploadIdempotencyKey: null },
    });
    // Reconcile primaries: if we removed the primary, this promotes the next
    // most-recently-edited active résumé (and self-heals any drift) so the user
    // always has exactly one primary while any résumé remains.
    await this.normalizePrimary(userId);
    logger.info('RA_V2_RESUME', 'resume soft-deleted', { userId, resumeId: id });
  }
}

export const raResumeService = new RAResumeService();

/**
 * Delete the stored copy of an exported application file (RAApplicationArtifact
 * .storageKey). Local keys go through the local provider, everything else
 * through the brand bucket the key belongs to. False = not confirmed gone, so
 * the caller holds the row back (never orphaned).
 */
export async function deleteArtifactObject(key: string): Promise<boolean> {
  const { resumeOriginalFileStorageService } = await import('../../../services/ResumeOriginalFileStorageService.js');
  // The key names its store (`cn/` = GoApply's own bucket, anything else the shared store), so the
  // object is found wherever it was written, whatever the brand's storage rule is today.
  const provider = resumeOriginalFileStorageService.providerOfKey(key);
  return resumeOriginalFileStorageService.deleteFile({ provider, key, fileName: null, mimeType: null });
}

let deletersRegistered = false;

/**
 * Register the artifact-file deleter with compliance retention (180-day purge,
 * WP-13) and the account purge (WP-10). Idempotent; the resumes router calls
 * it when it loads.
 */
export async function registerResumeArtifactDeleters(): Promise<void> {
  if (deletersRegistered) return;
  deletersRegistered = true;
  const [{ registerArtifactStorageDeleter }, { setArtifactStorageDeleter }] = await Promise.all([
    import('../../../features/compliance/index.js'),
    import('../../services/SeekerAccountPurgeService.js'),
  ]);
  registerArtifactStorageDeleter((row) => deleteArtifactObject(row.storageKey));
  setArtifactStorageDeleter((key) => deleteArtifactObject(key));
}
