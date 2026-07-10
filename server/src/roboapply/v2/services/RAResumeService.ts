// backend/src/roboapply/v2/services/RAResumeService.ts
//
// Resume variant CRUD. Four creation modes:
//   1. blank          — empty markdown shell, user fills it in
//   2. upload         — multipart file upload, parsed to markdown text
//   3. from_jd        — call RAJDParseAgent then RAResumeTailorAgent (BE3-owned)
//   4. from_existing  — duplicate an existing variant (back-compat name for
//                       the stub's `tailored_for_jd` mode that copies a base)
//
// The frontend stub uses three discriminator kinds: 'base' | 'tailored_for_jd'
// | 'from_template'. We accept all of those plus the four mode aliases the
// prompt mentions, mapping them to RAResumeVariant.kind:
//
//   ResumeCreateBody.kind = 'base'              -> kind='base'
//   ResumeCreateBody.kind = 'tailored_for_jd'   -> kind='tailored_for_jd' (also from_jd mode)
//   ResumeCreateBody.kind = 'from_template'     -> kind='from_template'
//
// Per the Resume Match Quota Rule, `ra_resume_tailor` deduction is written
// ONLY after the agent returns successfully — failure pays zero.

import crypto from 'crypto';
import prisma from '../../../lib/prisma.js';
import { writeDeductionLog } from '../../../lib/matchBilling.js';
import { costPatchFromTally } from '../../../lib/deductionCost.js';
import { getCurrentRequestId } from '../../../lib/requestContext.js';
import { logger } from '../../../services/LoggerService.js';
import { applyTailorSelections, type RATailorChange } from './RAResumeAIService.js';
import {
  ingestCandidateResume,
  CandidateResumeIngestError,
  type CandidateResumeIngestResult,
} from '../../../lib/candidateResumeIngest.js';
import {
  fetchLinkedInProfileAsText,
  cleanLinkedInExportText,
  isLinkedInUrlImportConfigured,
  normalizeLinkedInUrl,
  LinkedInImportError,
} from '../../../lib/linkedin/linkedInImport.js';

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
}

export type ResumeCreateInput =
  | { kind: 'base'; name: string; resumeMarkdown: string }
  | {
      kind: 'tailored_for_jd';
      name: string;
      basedOnVariantId: string;
      targetJobId: string;
    }
  | { kind: 'from_template'; name: string; templateKey: string };

export interface ResumePatchInput {
  name?: string;
  resumeMarkdown?: string;
}

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
  };
}

function toSummary(row: any, jobsById: Map<string, any>): RAResumeVariantSummary {
  const targetJob = row.targetJobId ? jobsById.get(row.targetJobId) : null;
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
          select: { id: true, title: true, companyName: true },
        })
      : [];
    const jobsById = new Map<string, any>(jobs.map((j: any) => [j.id, j]));
    return (rows as any[]).map((r) => toSummary(r, jobsById));
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
      // Zero primaries — promote the most-recently-edited active résumé, if any.
      const next = await t.rAResumeVariant.findFirst({
        where: { userId, deletedAt: null },
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

    // tailored_for_jd: clone a base variant, then call BE3's
    // RAResumeTailorAgent to rewrite for the target job. Quota deduction is
    // written ONLY after the agent returns successfully.
    const base = await p.rAResumeVariant.findFirst({
      where: { id: body.basedOnVariantId, userId, deletedAt: null },
    });
    if (!base) throw new ResumeNotFoundError();
    const targetJob = await p.rAJob.findUnique({ where: { id: body.targetJobId } });
    if (!targetJob) throw new ResumeValidationError('targetJobId not found');

    let tailoredMarkdown: string = base.resumeMarkdown;
    let agentSucceeded = false;
    try {
      // BE3 owns this module. The interface is a single `.run(input)` method
      // per spec §5. Failure costs zero (no writeDeductionLog).
      const { RAResumeTailorAgent } = await import('../agents/RAResumeTailorAgent.js');
      const agent = new RAResumeTailorAgent();
      const result = await agent.run({
        baseResumeMarkdown: base.resumeMarkdown,
        jobTitle: targetJob.title,
        jobDescription: targetJob.description ?? '',
        parsedJD: {
          qualifications: targetJob.qualifications ?? undefined,
          responsibilities: targetJob.responsibilities ?? undefined,
          benefits: targetJob.benefits ?? undefined,
        },
        complexity: 'standard',
      }, { locale });
      tailoredMarkdown = result?.tailoredResumeMarkdown ?? base.resumeMarkdown;
      agentSucceeded = true;
    } catch (err) {
      logger.warn('RA_V2_RESUME', 'tailor agent failed; falling back to base copy', {
        userId,
        basedOnVariantId: body.basedOnVariantId,
        targetJobId: body.targetJobId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: copy base with a header pointing at the target job. The
      // user pays zero (no writeDeductionLog called).
      tailoredMarkdown = `> Tailored for **${targetJob.companyName} — ${targetJob.title}**\n\n${base.resumeMarkdown}`;
    }

    const created = await p.rAResumeVariant.create({
      data: {
        userId,
        name: body.name.trim(),
        kind: 'tailored_for_jd',
        targetJobId: body.targetJobId,
        basedOnVariantId: body.basedOnVariantId,
        templateKey: null,
        resumeMarkdown: tailoredMarkdown,
        resumeContentHash: sha256(tailoredMarkdown),
        matchScoreCached: null,
        sourceKind: 'tailored',
        lastEditedAt: new Date(),
      },
    });

    if (agentSucceeded) {
      // Quota: commit-on-success only. Match the Resume Match Quota Rule.
      const cost = costPatchFromTally(getCurrentRequestId());
      await writeDeductionLog({
        userId,
        sku: 'ra_resume_tailor',
        source: 'plan',
        platformCostUsd: cost.platformCostUsd,
        units: 1,
        requestId: getCurrentRequestId() ?? null,
        relatedEntityType: 'ra_resume_variant',
        relatedEntityId: created.id,
        metadata: {
          ...cost.metadata,
          source: 'roboapply_v2',
          agent: 'RAResumeTailorAgent',
          targetJobId: body.targetJobId,
        },
      });
    }

    logger.info('RA_V2_RESUME', 'resume created (tailored_for_jd)', {
      userId,
      resumeId: created.id,
      basedOnVariantId: body.basedOnVariantId,
      targetJobId: body.targetJobId,
      agentSucceeded,
    });
    await this.normalizePrimary(userId);
    return this.reloadView(created.id);
  }

  /**
   * Persist the tailor PREVIEW as a new kind='tailored_for_jd' variant — the
   * "Apply" of the tailor-diff flow. Takes the tailored markdown the user
   * previewed (plus their per-change selections) and creates the variant
   * deterministically, with NO LLM re-run and NO new charge (the tailor was
   * already billed at preview time). Fixes the prior apply, which re-ran the
   * agent — double-charging and producing a different resume than the preview.
   */
  async applyTailoredMarkdown(
    userId: string,
    baseId: string,
    body: {
      tailoredResumeMarkdown: string;
      changes?: RATailorChange[];
      acceptedChangeIds?: string[] | null;
      targetJobId?: string;
      /** Manual-target lineage (tailored without a saved job). */
      targetCompany?: string;
      targetTitle?: string;
      name?: string;
    },
  ): Promise<RAResumeVariantView> {
    const p = prisma as any;
    const base = await p.rAResumeVariant.findFirst({
      where: { id: baseId, userId, deletedAt: null },
    });
    if (!base) throw new ResumeNotFoundError();

    const provided = (body.tailoredResumeMarkdown ?? '').trim();
    if (provided.length < 20) {
      throw new ResumeValidationError('tailoredResumeMarkdown is required');
    }

    const finalMd = applyTailorSelections(
      provided,
      body.changes ?? [],
      body.acceptedChangeIds ?? null,
    );

    let targetJobId: string | null = null;
    let jobLabel = '';
    if (body.targetJobId) {
      const job = await p.rAJob.findUnique({ where: { id: body.targetJobId } });
      if (job) {
        targetJobId = job.id;
        jobLabel = `${job.companyName} — ${job.title}`;
      }
    }
    // Manual-target lineage: with no saved job, the typed company/title still
    // name the variant and persist as meta so the lineage isn't lost.
    const targetCompany = (body.targetCompany ?? '').trim().slice(0, 200);
    const targetTitle = (body.targetTitle ?? '').trim().slice(0, 200);
    if (!jobLabel && targetCompany) {
      jobLabel = targetTitle ? `${targetCompany} — ${targetTitle}` : targetCompany;
    }
    const name = (body.name?.trim() || (jobLabel ? `Tailored — ${jobLabel}` : `Tailored — ${base.name}`)).slice(0, 200);

    const created = await p.rAResumeVariant.create({
      data: {
        userId,
        name,
        kind: 'tailored_for_jd',
        targetJobId,
        basedOnVariantId: base.id,
        templateKey: null,
        resumeMarkdown: finalMd,
        resumeContentHash: sha256(finalMd),
        matchScoreCached: null,
        sourceKind: 'tailored',
        lastEditedAt: new Date(),
        // parsedData is the variant's only JSON column; tailored variants
        // never carry an upload parse, so the namespaced key can't collide
        // with ParsedResume output. No schema change.
        ...(targetCompany || targetTitle
          ? {
              parsedData: {
                tailorTarget: {
                  company: targetCompany || null,
                  title: targetTitle || null,
                },
              },
            }
          : {}),
      },
    });
    logger.info('RA_V2_RESUME', 'tailored variant applied from preview (no re-run)', {
      userId,
      resumeId: created.id,
      baseId,
      targetJobId,
      selective: Array.isArray(body.acceptedChangeIds),
    });
    await this.normalizePrimary(userId);
    return this.reloadView(created.id);
  }

  /**
   * Upload + parse a résumé file into a new kind='base' variant. Reuses the
   * RoboHire parse pipeline via the candidate ingest helper (no recruiter
   * Resume table, no recruiter quota). The original bytes are stored in
   * candidate-scoped object storage. The first résumé becomes primary.
   */
  async uploadAndCreate(
    userId: string,
    params: { buffer: Buffer; fileName: string; mimeType: string; requestId?: string; name?: string },
  ): Promise<RAResumeVariantView> {
    const p = prisma as any;

    let ingest: CandidateResumeIngestResult;
    try {
      ingest = await ingestCandidateResume({
        buffer: params.buffer,
        fileName: params.fileName,
        mimeType: params.mimeType,
        requestId: params.requestId,
        userId,
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

    const created = await p.rAResumeVariant.create({
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
        lastEditedAt: new Date(),
      },
    });
    logger.info('RA_V2_RESUME', `resume created (${opts.sourceKind})`, {
      userId,
      resumeId: created.id,
      hasOriginal: !!ingest.original,
    });
    await this.normalizePrimary(userId);
    return this.reloadView(created.id);
  }

  /**
   * Import a résumé from LinkedIn into a new kind='base' variant tagged
   * `sourceKind: 'linkedin'`. Two modes, one parse pipeline:
   *
   *   - mode 'pdf': the member's "Save to PDF" export. The PDF bytes go through
   *     the same candidate ingest as a normal upload, with a LinkedIn-specific
   *     text pre-clean (footer stripping). Always available.
   *
   *   - mode 'url': a public profile URL. A config-gated enrichment provider
   *     (Proxycurl-compatible) fetches the structured profile, which we render
   *     to text and run through the identical parse pipeline. INERT unless
   *     `LINKEDIN_ENRICH_API_KEY` is set — otherwise throws
   *     ResumeUploadError('url_import_not_configured').
   *
   * FREE (no quota debit), mirroring upload-parse. The original file is only
   * retained for the PDF mode (URL mode has no file).
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
  ): Promise<RAResumeVariantView> {
    if (params.mode === 'pdf') {
      if (!params.buffer || params.buffer.length === 0) {
        throw new ResumeUploadError('file_required', 'A LinkedIn PDF export is required.');
      }
      let ingest: CandidateResumeIngestResult;
      try {
        ingest = await ingestCandidateResume({
          buffer: params.buffer,
          fileName: params.fileName || 'linkedin.pdf',
          mimeType: params.mimeType || 'application/pdf',
          requestId: params.requestId,
          userId,
          textTransform: cleanLinkedInExportText,
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

    // mode 'url' — config-gated enrichment fetch → text → same parse pipeline.
    if (!isLinkedInUrlImportConfigured()) {
      throw new ResumeUploadError(
        'url_import_not_configured',
        'LinkedIn URL import is not enabled on this deployment.',
      );
    }
    if (!normalizeLinkedInUrl(params.linkedinUrl || '')) {
      throw new ResumeUploadError('invalid_url', 'That does not look like a LinkedIn profile URL.');
    }

    let profileText: string;
    let profileName: string;
    try {
      const fetched = await fetchLinkedInProfileAsText(params.linkedinUrl!, {
        requestId: params.requestId,
      });
      profileText = fetched.text;
      profileName = fetched.displayName;
    } catch (err) {
      if (err instanceof LinkedInImportError) {
        throw new ResumeUploadError(err.code, err.message);
      }
      throw err;
    }

    let ingest: CandidateResumeIngestResult;
    try {
      ingest = await ingestCandidateResume({
        buffer: Buffer.from(profileText, 'utf8'),
        fileName: 'linkedin-profile.txt',
        mimeType: 'text/plain',
        requestId: params.requestId,
        userId,
        storeOriginal: false, // synthetic text, not a real uploaded file
      });
    } catch (err) {
      if (err instanceof CandidateResumeIngestError) {
        throw new ResumeUploadError(err.code, err.message);
      }
      throw err;
    }

    return this.persistIngestedBase(userId, ingest, {
      name: params.name || profileName,
      sourceKind: 'linkedin',
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

  async patch(userId: string, id: string, body: ResumePatchInput): Promise<RAResumeVariantView> {
    const p = prisma as any;
    const existing = await p.rAResumeVariant.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new ResumeNotFoundError();
    const data: any = { lastEditedAt: new Date() };
    if (body.name !== undefined) data.name = body.name;
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
          where: { userId, jobId: { not: null } },
        });
        if (dependents > 0) {
          throw new ResumeInUseError(dependents);
        }
      }
    }
    await p.rAResumeVariant.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Reconcile primaries: if we removed the primary, this promotes the next
    // most-recently-edited active résumé (and self-heals any drift) so the user
    // always has exactly one primary while any résumé remains.
    await this.normalizePrimary(userId);
    logger.info('RA_V2_RESUME', 'resume soft-deleted', { userId, resumeId: id });
  }
}

export const raResumeService = new RAResumeService();
